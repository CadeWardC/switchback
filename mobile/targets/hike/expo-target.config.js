// The widget extension that draws the hike on the lock screen and in the Dynamic Island (a Live Activity).
// `expo prebuild` adds it to the Xcode project (@bacons/apple-targets, see app.config.js). The app starts
// and updates the activity through the local module in modules/hike-activity.
/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: 'widget',
  name: 'SwitchbackHike',
  displayName: 'Switchback',
  bundleIdentifier: '.hike',
  deploymentTarget: '16.4',
  frameworks: ['SwiftUI', 'WidgetKit', 'ActivityKit'],
};
