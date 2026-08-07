#!/usr/bin/env node

const { URLSearchParams } = require('node:url');

function printHelp() {
  console.log(`Usage: npm run report -- --username <name> --description <text> [--email <email>] [--type <type>] [--url <endpoint>]

Examples:
  npm run report -- --username Steve --description "Griefing happened" --email steve@example.com
  npm run report -- --username Steve --description "Need help" --type Harassment --url https://cosmixmc.org/api/report
`);
}

function parseArgs(argv) {
  const options = {
    username: '',
    email: '',
    type: 'Other',
    description: '',
    url: process.env.REPORT_API_URL || 'https://cosmixmc.org/api/report',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') {
      options.help = true;
      continue;
    }

    if (value === '--username') {
      options.username = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (value === '--email') {
      options.email = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (value === '--type') {
      options.type = argv[index + 1] || 'Other';
      index += 1;
      continue;
    }

    if (value === '--description') {
      options.description = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (value === '--url') {
      options.url = argv[index + 1] || options.url;
      index += 1;
      continue;
    }

    if (!options.description && value && !value.startsWith('--')) {
      options.description = value;
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (!options.username.trim() || !options.description.trim()) {
    console.error('Please provide --username and --description.');
    printHelp();
    process.exitCode = 1;
    return;
  }

  const params = new URLSearchParams({
    username: options.username,
    type: options.type,
    description: options.description,
    email: options.email,
  });

  const requestUrl = options.url.includes('?')
    ? `${options.url}&${params.toString()}`
    : `${options.url}?${params.toString()}`;

  try {
    const response = await fetch(requestUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        payload = { message: text };
      }
    }

    if (!response.ok) {
      console.error(`Request failed with status ${response.status}.`);
      if (payload.error) {
        console.error(payload.error);
      }
      process.exitCode = 1;
      return;
    }

    console.log(payload.message || 'Report sent successfully.');
  } catch (error) {
    console.error(error.message || 'Unable to send the report.');
    process.exitCode = 1;
  }
}

main();
