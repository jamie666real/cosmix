process.env.PORT = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAccountDeletionDiscordPayload, buildApplicationCommandDefinitions, buildApplicationDiscordPayload, buildDiscordEmbed, buildDiscordPayload, buildReportLogPayload, buildTranscript, buildDiscordAuthHeader, parseDiscordResponse, parsePermissions, getDiscordConfig, buildDiscordWebhookPayload, normalizeSignupPayload, startServer } = require('../server'); 

test('normalizeSignupPayload allows signing up without an email', () => {
  const payload = normalizeSignupPayload({ username: 'GuestUser', password: 'secret' });

  assert.equal(payload.email, '');
  assert.equal(payload.username, 'GuestUser');
  assert.equal(payload.password, 'secret');
});

test('buildDiscordEmbed includes the report metadata and action buttons', () => {
  const embed = buildDiscordEmbed({
    reportId: 'ABC123',
    username: 'Steve',
    type: 'Griefing',
    description: 'Destroyed my base',
    email: 'reporter@example.com',
  });

  assert.equal(embed.title, 'New report submitted');
  assert.equal(embed.color, 0xf59e0b);
  assert.equal(embed.fields[0].name, 'Reporter');
  assert.equal(embed.fields[0].value, 'Steve');
  assert.equal(embed.fields[2].name, 'Email');
  assert.equal(embed.fields[2].value, 'reporter@example.com');
});

test('buildTranscript records the report lifecycle in order', () => {
  const transcript = buildTranscript({
    reportId: 'ABC123',
    username: 'Steve',
    type: 'Griefing',
    description: 'Destroyed my base',
    email: 'reporter@example.com',
    actions: [
      { action: 'claimed', actor: 'Mod Jane' },
      { action: 'resolved', actor: 'Mod Jane', reason: 'Issue handled' },
    ],
  });

  assert.match(transcript, /Report ID: ABC123/);
  assert.match(transcript, /claimed/);
  assert.match(transcript, /resolved/);
  assert.match(transcript, /Issue handled/);
});

test('buildDiscordAuthHeader preserves an existing auth prefix and adds one for raw tokens', () => {
  assert.equal(buildDiscordAuthHeader('abc123'), 'Bot abc123');
  assert.equal(buildDiscordAuthHeader('Bot abc123'), 'Bot abc123');
  assert.equal(buildDiscordAuthHeader('Bearer abc123'), 'Bearer abc123');
});

test('getDiscordConfig defaults to the requested guild ID when none is configured', () => {
  delete process.env.DISCORD_GUILD_ID;
  delete process.env.DISCORD_WEBHOOK_URL;

  const config = getDiscordConfig();

  assert.equal(config.guildId, '1522777296547876884');
  assert.equal(config.webhookUrl, '');
});

test('getDiscordConfig uses the webhook URL for report delivery', () => {
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.example/webhook';
  process.env.DISCORD_BOT_TOKEN = 'bot-token';

  const config = getDiscordConfig();

  assert.equal(config.webhookUrl, 'https://discord.example/webhook');
  assert.equal(config.botToken, 'bot-token');
});

test('buildDiscordPayload returns a Discord-compatible embed payload', () => {
  const payload = buildDiscordPayload({
    reportId: 'ABC123',
    username: 'Steve',
    type: 'Griefing',
    description: 'Destroyed my base',
    email: 'reporter@example.com',
  });

  assert.equal(payload.content, 'New report submitted from CosmixMC');
  assert.equal(payload.embeds[0].title, 'New report submitted');
  assert.equal(payload.embeds[0].fields[0].name, 'Reporter');
  assert.equal(payload.components, undefined);
});

test('buildDiscordWebhookPayload uses the signed-in website username and avatar when sending chat messages', () => {
  const payload = buildDiscordWebhookPayload({
    content: 'Hello from the site',
    username: 'CosmixUser',
    avatarUrl: 'https://example.com/avatar.png',
  });

  assert.equal(payload.content, 'Hello from the site');
  assert.equal(payload.username, 'CosmixUser');
  assert.equal(payload.avatar_url, 'https://example.com/avatar.png');
});

test('buildAccountDeletionDiscordPayload formats deletion requests for the account-delete webhook', () => {
  const payload = buildAccountDeletionDiscordPayload({
    username: 'Steve',
    email: 'steve@example.com',
    description: 'I want to leave the server.',
  });

  assert.equal(payload.content, 'Account deletion request received');
  assert.equal(payload.embeds[0].title, 'Account deletion request');
  assert.equal(payload.embeds[0].fields[0].name, 'Username');
  assert.equal(payload.embeds[0].fields[1].value, 'steve@example.com');
});

test('buildApplicationDiscordPayload includes accept and deny options for staff review', () => {
  const payload = buildApplicationDiscordPayload({
    applicationId: 'APP-123',
    username: 'Steve',
    position: 'Moderator',
    reason: 'I want to help the community.',
    email: 'steve@example.com',
  });

  assert.equal(payload.content, 'New staff application received');
  assert.equal(payload.embeds[0].title, 'New staff application');
  assert.equal(payload.components[0].components[0].label, 'Accept application');
  assert.equal(payload.components[0].components[1].label, 'Deny application');
});

test('buildApplicationCommandDefinitions exposes slash commands for each report action', () => {
  const commands = buildApplicationCommandDefinitions();

  assert.deepEqual(commands.map((command) => command.name), ['claim', 'close', 'close-reason', 'resolve', 'resolve-reason']);
  assert.equal(commands[1].options[0].name, 'report_id');
  assert.equal(commands[2].options[1].name, 'reason');
});

test('parsePermissions recognizes staff and admin roles for website access', () => {
  const permissions = parsePermissions({ roles: ['staff', 'mod'], permissions: ['admin'] });

  assert.equal(permissions.isStaff, true);
  assert.equal(permissions.isAdmin, true);
  assert.equal(permissions.canManageReports, true);
});

test('parsePermissions treats owner roles as privileged staff access', () => {
  const permissions = parsePermissions({ roles: ['owner'], permissions: [] });

  assert.equal(permissions.isStaff, true);
  assert.equal(permissions.isAdmin, true);
  assert.equal(permissions.canManageReports, true);
});

test('buildReportLogPayload produces a structured log entry for the configured log channel', () => {
  const payload = buildReportLogPayload(
    { reportId: 'ABC123' },
    'closed-reason',
    'Inappropriate behavior',
    'Mod Jane',
    'Report closed by Mod Jane with reason'
  );

  assert.equal(payload.content, 'Report ABC123 log');
  assert.equal(payload.embeds[0].title, 'Report log');
  assert.equal(payload.embeds[0].fields[0].value, 'ABC123');
  assert.equal(payload.embeds[0].fields[2].value, 'Mod Jane');
  assert.equal(payload.embeds[0].fields[3].value, 'Inappropriate behavior');
});

test('parseDiscordResponse returns an empty object for successful empty bodies', async () => {
  const response = new Response('', { status: 200 });
  const parsed = await parseDiscordResponse(response);
  assert.deepEqual(parsed, {});
});

test('unknown api routes return JSON errors instead of plain text', async () => {
  const server = await startServer();
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/api/not-a-real-route`);
    const text = await response.text();

    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    assert.deepEqual(JSON.parse(text), { error: 'API endpoint not found.' });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
