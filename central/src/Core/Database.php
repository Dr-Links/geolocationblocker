<?php

declare(strict_types=1);

namespace Signalpost\Core;

use PDO;
use PDOStatement;

/**
 * Thin PDO wrapper. All queries use native prepared statements
 * (emulation disabled); there is no API for interpolating values into SQL.
 */
final class Database
{
    private ?PDO $pdo = null;
    private int $txDepth = 0;

    public function __construct(private readonly Config $config)
    {
    }

    public function pdo(): PDO
    {
        if ($this->pdo === null) {
            $c = $this->config;
            $socket = (string) $c->get('db.socket');
            $dsn = $socket !== ''
                ? sprintf('mysql:unix_socket=%s;dbname=%s;charset=%s', $socket, $c->get('db.name'), $c->get('db.charset'))
                : sprintf('mysql:host=%s;port=%d;dbname=%s;charset=%s', $c->get('db.host'), $c->int('db.port'), $c->get('db.name'), $c->get('db.charset'));
            $this->pdo = new PDO($dsn, (string) $c->get('db.user'), (string) $c->get('db.password'), [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
                PDO::ATTR_STRINGIFY_FETCHES => false,
            ]);
            $this->pdo->exec("SET time_zone = '+00:00', sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION,ERROR_FOR_DIVISION_BY_ZERO'");
        }
        return $this->pdo;
    }

    public function run(string $sql, array $params = []): PDOStatement
    {
        $stmt = $this->pdo()->prepare($sql);
        foreach ($params as $key => $value) {
            $name = is_int($key) ? $key + 1 : (str_starts_with($key, ':') ? $key : ':' . $key);
            $type = match (true) {
                is_int($value) => PDO::PARAM_INT,
                is_bool($value) => PDO::PARAM_BOOL,
                $value === null => PDO::PARAM_NULL,
                default => PDO::PARAM_STR,
            };
            $stmt->bindValue($name, $value, $type);
        }
        $stmt->execute();
        return $stmt;
    }

    public function one(string $sql, array $params = []): ?array
    {
        $row = $this->run($sql, $params)->fetch();
        return $row === false ? null : $row;
    }

    public function all(string $sql, array $params = []): array
    {
        return $this->run($sql, $params)->fetchAll();
    }

    public function value(string $sql, array $params = []): mixed
    {
        $v = $this->run($sql, $params)->fetchColumn();
        return $v === false ? null : $v;
    }

    public function exec(string $sql, array $params = []): int
    {
        return $this->run($sql, $params)->rowCount();
    }

    /** Insert a row (column names are code-controlled, never user input) and return its ID. */
    public function insert(string $table, array $row): int
    {
        $cols = array_keys($row);
        foreach ($cols as $col) {
            if (preg_match('/^[a-z_][a-z0-9_]*$/', $col) !== 1) {
                throw new \InvalidArgumentException('Invalid column name.');
            }
        }
        if (preg_match('/^[a-z_][a-z0-9_]*$/', $table) !== 1) {
            throw new \InvalidArgumentException('Invalid table name.');
        }
        $sql = sprintf(
            'INSERT INTO `%s` (`%s`) VALUES (%s)',
            $table,
            implode('`,`', $cols),
            implode(',', array_map(static fn ($c) => ':' . $c, $cols))
        );
        $this->run($sql, $row);
        return (int) $this->pdo()->lastInsertId();
    }

    /**
     * Runs $fn in a transaction. Nested calls join the outer transaction.
     *
     * @template T
     * @param callable():T $fn
     * @return T
     */
    public function transaction(callable $fn): mixed
    {
        if ($this->txDepth > 0) {
            $this->txDepth++;
            try {
                return $fn();
            } finally {
                $this->txDepth--;
            }
        }
        $pdo = $this->pdo();
        $pdo->beginTransaction();
        $this->txDepth = 1;
        try {
            $result = $fn();
            $pdo->commit();
            return $result;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        } finally {
            $this->txDepth = 0;
        }
    }

    public function isDuplicateKey(\PDOException $e): bool
    {
        return ($e->errorInfo[1] ?? null) === 1062;
    }
}
