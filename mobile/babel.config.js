// The Expo preset (it adds the Reanimated/worklets plugin by itself). Written out only so Jest uses it too.
module.exports = function (api) {
  api.cache(true);
  return { presets: [require.resolve('babel-preset-expo', { paths: [require.resolve('expo/package.json')] })] };
};
