const { getAuthUrl, exchangeCode } = require('./auth');

const code = process.argv[2];

if (!code) {
  console.log('Visit this URL, approve access, then copy the code and re-run:');
  console.log('  node setup-auth.js <code>');
  console.log();
  console.log(getAuthUrl());
} else {
  exchangeCode(code).then(tokens => {
    console.log('Saved refresh token to config/token.json');
    console.log('has refresh_token:', !!tokens.refresh_token);
  }).catch(err => {
    console.error('Exchange failed:', err.message);
    process.exit(1);
  });
}
