export function formatMoney(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
}

export function formatDate(d: Date | null | undefined) {
  return d ? d.toISOString().slice(0, 10) : "—";
}

export const intervalLabel = (i: "MONTH" | "YEAR" | null | undefined) => (i === "YEAR" ? "yr" : "mo");

export const formatLimit = (n: number) => (n < 0 ? "Unlimited" : n.toLocaleString("en-US"));
