// Unit tests for this app's own pure logic (src/core), run in plain Node with the Expo Babel preset (no
// React Native runtime is needed for them). The website's logic keeps its own tests in web/.
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  resolver: '<rootDir>/test/resolver.js',
  moduleNameMapper: {
    '^@web/(.*)$': '<rootDir>/../web/src/$1',
    '^@preact/signals$': '@preact/signals-core',
  },
};
