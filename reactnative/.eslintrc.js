module.exports = {
  root: true,
  extends: '@react-native',
  overrides: [
    {
      files: ['jest.setup.js', 'jest.config.js', 'scripts/**/*.js'],
      env: {jest: true, node: true},
    },
    {
      files: ['__tests__/**/*.{ts,tsx,js}'],
      env: {jest: true, node: true},
    },
  ],
};
