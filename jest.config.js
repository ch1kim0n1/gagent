const path = require('path');
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testEnvironmentOptions: {
    url: 'http://localhost',
  },
  maxWorkers: 1,
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
  ],
  coverageThreshold: {
    'src/core/**/*.ts': {
      lines: 85,
      statements: 85,
      functions: 85,
      branches: 75,
    },
    global: {
      lines: 70,
      statements: 70,
      functions: 70,
      branches: 60,
    },
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  moduleDirectories: ['node_modules', path.resolve(__dirname, 'node_modules')],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  moduleNameMapper: {
    '^bun:test$': '<rootDir>/test/bun-test-shim.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
