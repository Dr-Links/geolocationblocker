// The app imports @app/shared from ../../packages/shared (outside this folder),
// so Metro must watch that folder too.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../../packages/shared')];

module.exports = config;
