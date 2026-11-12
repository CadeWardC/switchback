// Unit tests for this app's own pure logic (src/core). The website's logic keeps its own tests in web/.
module.exports = {
  preset: 'jest-expo',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  moduleNameMapper: {
    '^@web/(.*)$': '<rootDir>/../web/src/$1',
    '^@preact/signals$': '@preact/signals-core',
  },
};
