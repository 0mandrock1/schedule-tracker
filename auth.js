const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// unused (kept for future reference on config layout)
const CREDS_FILE = path.join(__dirname, 'config', 'oauth-client.json');
const TOKEN_FILE = path.join(__dirname, 'config', 'token.json');
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const REDIRECT_URI = 'https://mandrock-tools.duckdns.org/oauth/callback';

function loadClientCreds() {
  return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
}

function makeOAuthClient() {
  const { client_id, client_secret } = loadClientCreds();
  return new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);
}

function getAuthUrl() {
  const client = makeOAuthClient();
  return client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
}

async function exchangeCode(code) {
  const client = makeOAuthClient();
  const { tokens } = await client.getToken(code);
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  return tokens;
}

function getAuthedClient() {
  const client = makeOAuthClient();
  const tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  client.setCredentials(tokens);
  return client;
}

module.exports = { getAuthUrl, exchangeCode, getAuthedClient };
