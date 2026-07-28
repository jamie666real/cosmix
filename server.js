const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const rootDir = __dirname;
const host = process.env.HOST || '0.0.0.0';
const port = process.env.PORT || 3006;
const smtpHost = process.env.SMTP_HOST || '';
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpUser = process.env.SMTP_USER || '';
const smtpPass = process.env.SMTP_PASS || '';
const smtpFrom = process.env.SMTP_FROM || process.env.SMTP_USER || 'cosmix@localhost';

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const reportsById = new Map();
const reportsByMessageId = new Map();
const oauthSessions = new Map();
const emailSessions = new Map();
let rulesContent = [
  'Be respectful to other players and staff.',
  'No cheating, hacking, or exploiting bugs.',
  'Do not grief or destroy other players\' builds.',
  'Follow staff instructions at all times.',
];

const dataDir = path.join(rootDir, 'data');
const uploadsDir = path.join(rootDir, 'uploads');
const usersFile = path.join(dataDir, 'users.json');
const discordWebhookCacheFile = path.join(dataDir, 'discord-webhook.json');
const defaultDiscordGuildId = '1522777296547876884';
const defaultApplicationWebhookUrl = 'https://discord.com/api/webhooks/1530688116870877385/loZbOsb5BQaUW_4wvtZ-49eBGmHK9prYzLtjOep9BAnDQbPqLngMLhf1eyVV1fC7LjtH';
const defaultAccountDeletionWebhookUrl = 'https://discord.com/api/webhooks/1530688116870877385/loZbOsb5BQaUW_4wvtZ-49eBGmHK9prYzLtjOep9BAnDQbPqLngMLhf1eyVV1fC7LjtH';
let users = [];

function ensureStorageDirs() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
}

function loadUsers() {
  ensureStorageDirs();
  if (!fs.existsSync(usersFile)) {
    saveUsers();
    return;
  }

  try {
    const raw = fs.readFileSync(usersFile, 'utf8');
    const parsed = JSON.parse(raw);
    users = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    users = [];
    saveUsers();
  }
}

function saveUsers() {
  ensureStorageDirs();
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}

function loadDiscordWebhookCache() {
  ensureStorageDirs();
  if (!fs.existsSync(discordWebhookCacheFile)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(discordWebhookCacheFile, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    return null;
  }
}

function saveDiscordWebhookCache(cache) {
  ensureStorageDirs();
  fs.writeFileSync(discordWebhookCacheFile, JSON.stringify(cache, null, 2));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(8).toString('hex');
  const hash = crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(storedPassword, password) {
  if (!storedPassword || typeof storedPassword !== 'string') {
    return false;
  }

  const [salt, hash] = storedPassword.split(':');
  if (!salt || !hash) {
    return false;
  }

  return crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex') === hash;
}

function getUserByEmail(email) {
  const normalized = (email || '').trim().toLowerCase();
  return users.find((user) => user.email && user.email.toLowerCase() === normalized) || null;
}

function getUserById(id) {
  return users.find((user) => user.id === id) || null;
}

function normalizeSignupPayload(payload = {}) {
  return {
    email: (payload.email || '').trim().toLowerCase(),
    password: (payload.password || '').trim(),
    username: (payload.username || '').trim(),
  };
}

function createUserRecord({ email, password, username, avatar = '' }) {
  const normalizedEmail = (email || '').trim().toLowerCase();
  const normalizedUsername = (username || '').trim() || normalizedEmail.split('@')[0] || 'CosmixUser';
  return {
    id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    email: normalizedEmail,
    password: hashPassword(password),
    passwordPlain: password,
    username: normalizedUsername,
    avatar,
    role: 'member',
    createdAt: new Date().toISOString(),
  };
}

function buildSessionUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    avatar: user.avatar,
    role: user.role || 'member',
    roles: Array.isArray(user.roles) ? user.roles : [],
    permissions: Array.isArray(user.permissions) ? user.permissions : [],
    createdAt: user.createdAt,
  };
}

function serializeUserForOwnerList(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role || 'member',
    roles: Array.isArray(user.roles) ? user.roles : [],
    permissions: Array.isArray(user.permissions) ? user.permissions : [],
    createdAt: user.createdAt,
    password: user.passwordPlain || user.password || '',
  };
}

function getSessionUserPayload(session) {
  if (!session || !session.user) {
    return null;
  }

  const user = getUserById(session.user.id);
  if (!user) {
    return {
      ...session.user,
      role: session.user.role || 'member',
      roles: Array.isArray(session.user.roles) ? session.user.roles : [],
      permissions: Array.isArray(session.user.permissions) ? session.user.permissions : [],
    };
  }

  return buildSessionUser(user);
}

loadUsers();

function getOAuthConfig() {
  const clientId = (process.env.DISCORD_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = (process.env.DISCORD_OAUTH_CLIENT_SECRET || '').trim();
  const redirectUri = (process.env.DISCORD_OAUTH_REDIRECT_URI || '').trim();
  const scopes = (process.env.DISCORD_OAUTH_SCOPES || 'identify email').trim();
  return { clientId, clientSecret, redirectUri, scopes };
}

function getSessionId(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|; )sessionId=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function getSession(req) {
  const sessionId = getSessionId(req);
  if (!sessionId) {
    return null;
  }

  return emailSessions.get(sessionId) || oauthSessions.get(sessionId) || null;
}

function setSessionCookie(res, sessionId) {
  res.setHeader('Set-Cookie', `sessionId=${encodeURIComponent(sessionId)}; HttpOnly; Path=/; SameSite=Lax`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'sessionId=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
}

function parsePermissions(user) {
  const roles = Array.isArray(user?.roles) ? user.roles : [];
  const permissions = Array.isArray(user?.permissions) ? user.permissions : [];
  const normalized = new Set([...roles, ...permissions].map((value) => String(value || '').trim().toLowerCase()));
  const isOwner = normalized.has('owner') || normalized.has('co-owner') || normalized.has('coowner');
  return {
    isStaff: normalized.has('staff') || normalized.has('admin') || normalized.has('moderator') || isOwner,
    isAdmin: normalized.has('admin') || isOwner,
    canManageReports: normalized.has('staff') || normalized.has('admin') || normalized.has('moderator') || isOwner,
    raw: [...normalized],
  };
}

function buildOAuthRedirectUrl(state) {
  const { clientId, redirectUri, scopes } = getOAuthConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes,
    state,
  });
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(code, redirectUri) {
  const { clientId, clientSecret } = getOAuthConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });

  const response = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'CosmixMC-Report-Bridge/1.0',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Discord OAuth exchange failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

async function fetchDiscordUser(accessToken) {
  const response = await fetch('https://discord.com/api/users/@me', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'CosmixMC-Report-Bridge/1.0',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Discord user lookup failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

async function getMinecraftServerStatus(hostname, portNumber) {
  try {
    const response = await fetch(`https://api.mcsrvstat.us/2/${hostname}:${portNumber}`, {
      headers: { 'User-Agent': 'CosmixMC-Report-Bridge/1.0' },
    });
    const data = await response.json();
    if (!data || !data.online) {
      return { online: false, players: 0 };
    }

    return {
      online: true,
      players: data.players?.online || 0,
      maxPlayers: data.players?.max || 0,
      version: data.version || 'Unknown',
      hostname: data.hostname || hostname,
      description: data.description || 'cosmixmc.org',
    };
  } catch (error) {
    return { online: false, players: 0 };
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function createReportId() {
  const stamp = Date.now().toString(36).toUpperCase();
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RPT-${stamp}-${suffix}`;
}

function createApplicationId() {
  const stamp = Date.now().toString(36).toUpperCase();
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `APP-${stamp}-${suffix}`;
}

function getDiscordConfig() {
  const webhookUrl = (process.env.DISCORD_WEBHOOK_URL || '').trim();
  const applicationWebhookUrl = (process.env.DISCORD_APPLICATION_WEBHOOK_URL || defaultApplicationWebhookUrl).trim();
  const accountDeletionWebhookUrl = (process.env.DISCORD_ACCOUNT_DELETION_WEBHOOK_URL || defaultAccountDeletionWebhookUrl).trim();
  const guildId = (process.env.DISCORD_GUILD_ID || defaultDiscordGuildId).trim();
  const botToken = (process.env.DISCORD_BOT_TOKEN || '').trim();
  const channelId = (process.env.DISCORD_CHANNEL_ID || '').trim();
  const reportLogChannelId = (process.env.DISCORD_REPORT_LOG_CHANNEL_ID || '').trim();
  return {
    guildId,
    webhookUrl,
    applicationWebhookUrl,
    accountDeletionWebhookUrl,
    botToken,
    channelId,
    reportLogChannelId,
  };
}

function buildDiscordAuthHeader(token) {
  if (!token) {
    return '';
  }

  const normalizedToken = token.trim();
  if (normalizedToken.startsWith('Bot ') || normalizedToken.startsWith('Bearer ')) {
    return normalizedToken;
  }

  return `Bot ${normalizedToken}`;
}

function isPlaceholderDiscordValue(value) {
  return /^(your-(bot|channel)-token|your-channel-id|dummy|placeholder)$/i.test(value || '');
}

function truncate(value, limit = 1024) {
  const text = String(value || '').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function buildDiscordEmbed(payload) {
  const fields = [
    { name: 'Reporter', value: truncate(payload.username || 'Unknown'), inline: true },
    { name: 'Type', value: truncate(payload.type || 'Unknown'), inline: true },
    { name: 'Email', value: truncate(payload.email || 'Not provided'), inline: true },
    { name: 'Description', value: truncate(payload.description || 'No description provided') },
  ];

  if (payload.reason) {
    fields.push({ name: 'Reason', value: truncate(payload.reason) });
  }

  if (payload.statusText) {
    fields.push({ name: 'Status', value: truncate(payload.statusText) });
  }

  return {
    title: payload.embedTitle || 'New report submitted',
    description: payload.descriptionText || 'A report has been submitted from the CosmixMC web form.',
    color: payload.color || 0xf59e0b,
    fields,
    footer: {
      text: `Report ID: ${payload.reportId || 'Unknown'}`,
    },
    timestamp: new Date().toISOString(),
  };
}

function buildDiscordPayload(payload) {
  return {
    content: payload.content || 'New report submitted from CosmixMC',
    embeds: [buildDiscordEmbed(payload)],
    allowed_mentions: {
      parse: [],
    },
  };
}

function buildAccountDeletionDiscordPayload(payload) {
  return {
    content: 'Account deletion request received',
    embeds: [{
      title: 'Account deletion request',
      description: 'A user has requested account deletion from the website.',
      color: 0xef4444,
      fields: [
        { name: 'Username', value: truncate(payload.username || 'Unknown'), inline: true },
        { name: 'Email', value: truncate(payload.email || 'Not provided'), inline: true },
        { name: 'Reason', value: truncate(payload.description || 'No reason provided') },
      ],
      footer: {
        text: `Request ID: ${payload.reportId || 'Unknown'}`,
      },
      timestamp: new Date().toISOString(),
    }],
    allowed_mentions: {
      parse: [],
    },
  };
}

function buildApplicationDiscordPayload(payload) {
  return {
    content: 'New staff application received',
    embeds: [{
      title: 'New staff application',
      description: `Application ${payload.applicationId || 'Unknown'} submitted from the CosmixMC website.`,
      color: 0x22c55e,
      fields: [
        { name: 'Applicant', value: truncate(payload.username || 'Unknown'), inline: true },
        { name: 'Position', value: truncate(payload.position || 'Unknown'), inline: true },
        { name: 'Email', value: truncate(payload.email || 'Not provided'), inline: true },
        { name: 'Reason', value: truncate(payload.reason || 'No reason provided') },
      ],
      footer: {
        text: `Application ID: ${payload.applicationId || 'Unknown'}`,
      },
      timestamp: new Date().toISOString(),
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 3, label: 'Accept application', custom_id: `accept_application:${payload.applicationId || 'unknown'}` },
        { type: 2, style: 4, label: 'Deny application', custom_id: `deny_application:${payload.applicationId || 'unknown'}` },
      ],
    }],
    allowed_mentions: {
      parse: [],
    },
  };
}

function buildDiscordWebhookPayload(payload) {
  return {
    content: payload.content || '',
    username: payload.username || 'CosmixMC',
    avatar_url: payload.avatarUrl || '',
    allowed_mentions: {
      parse: [],
    },
  };
}

function buildApplicationCommandDefinitions() {
  return [
    {
      name: 'claim',
      description: 'Claim a submitted report',
      options: [{ name: 'report_id', description: 'The report ID to claim', type: 3, required: true }],
    },
    {
      name: 'close',
      description: 'Close a report',
      options: [{ name: 'report_id', description: 'The report ID to close', type: 3, required: true }],
    },
    {
      name: 'close-reason',
      description: 'Close a report with a reason',
      options: [
        { name: 'report_id', description: 'The report ID to close', type: 3, required: true },
        { name: 'reason', description: 'The reason for closing the report', type: 3, required: true },
      ],
    },
    {
      name: 'resolve',
      description: 'Resolve a report',
      options: [{ name: 'report_id', description: 'The report ID to resolve', type: 3, required: true }],
    },
    {
      name: 'resolve-reason',
      description: 'Resolve a report with a reason',
      options: [
        { name: 'report_id', description: 'The report ID to resolve', type: 3, required: true },
        { name: 'reason', description: 'The reason for resolving the report', type: 3, required: true },
      ],
    },
  ];
}

function buildTranscript(payload) {
  const lines = [
    `Report ID: ${payload.reportId || 'Unknown'}`,
    `Reporter: ${payload.username || 'Unknown'}`,
    `Type: ${payload.type || 'Unknown'}`,
    `Email: ${payload.email || 'Not provided'}`,
    `Description: ${payload.description || 'No description provided'}`,
    'Timeline:',
  ];

  const actions = Array.isArray(payload.actions) && payload.actions.length > 0 ? payload.actions : [{ action: 'submitted', actor: 'Reporter' }];
  actions.forEach((entry, index) => {
    const reason = entry.reason ? ` — Reason: ${entry.reason}` : '';
    lines.push(`${index + 1}. ${entry.action} by ${entry.actor || 'Staff'}${reason}`);
  });

  return lines.join('\n');
}

async function parseDiscordResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return { raw: text };
  }
}

async function ensureDiscordWebhookUrl() {
  const { webhookUrl, guildId, botToken, channelId } = getDiscordConfig();

  if (webhookUrl && !isPlaceholderDiscordValue(webhookUrl)) {
    return webhookUrl;
  }

  const cachedWebhook = loadDiscordWebhookCache();
  if (cachedWebhook?.webhookUrl && cachedWebhook?.guildId === guildId && (!channelId || cachedWebhook?.channelId === channelId)) {
    return cachedWebhook.webhookUrl;
  }

  if (!botToken || !guildId) {
    throw new Error('Discord webhook is not configured. Set DISCORD_WEBHOOK_URL or configure DISCORD_BOT_TOKEN and DISCORD_GUILD_ID.');
  }

  const channelListResponse = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
    headers: {
      Authorization: buildDiscordAuthHeader(botToken),
      'User-Agent': 'CosmixMC-Report-Bridge/1.0',
    },
  });

  if (!channelListResponse.ok) {
    const errorText = await channelListResponse.text();
    throw new Error(`Discord channel lookup failed: ${channelListResponse.status} ${errorText}`);
  }

  const channels = await channelListResponse.json();
  const targetChannel = Array.isArray(channels)
    ? (channelId
      ? channels.find((entry) => entry?.id === channelId && entry?.type === 0)
      : channels.find((entry) => entry?.type === 0))
    : null;

  if (!targetChannel) {
    throw new Error(`No text channel is available in Discord guild ${guildId}.`);
  }

  const webhookResponse = await fetch(`https://discord.com/api/v10/channels/${targetChannel.id}/webhooks`, {
    method: 'POST',
    headers: {
      Authorization: buildDiscordAuthHeader(botToken),
      'Content-Type': 'application/json',
      'User-Agent': 'CosmixMC-Report-Bridge/1.0',
    },
    body: JSON.stringify({ name: 'CosmixMC Website' }),
  });

  if (!webhookResponse.ok) {
    const errorText = await webhookResponse.text();
    throw new Error(`Discord webhook creation failed: ${webhookResponse.status} ${errorText}`);
  }

  const createdWebhook = await webhookResponse.json();
  if (!createdWebhook?.url) {
    throw new Error('Discord did not return a webhook URL.');
  }

  saveDiscordWebhookCache({ guildId, channelId: targetChannel.id, webhookUrl: createdWebhook.url });
  return createdWebhook.url;
}

async function sendToDiscord(payload) {
  const webhookUrl = await ensureDiscordWebhookUrl();

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'CosmixMC-Report-Bridge/1.0',
    },
    body: JSON.stringify(buildDiscordPayload(payload)),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Discord webhook rejected the request: ${response.status} ${errorText}`);
  }

  return parseDiscordResponse(response);
}

async function sendDiscordChatMessage(payload) {
  const webhookUrl = await ensureDiscordWebhookUrl();

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'CosmixMC-Report-Bridge/1.0',
    },
    body: JSON.stringify(buildDiscordWebhookPayload(payload)),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Discord chat webhook rejected the request: ${response.status} ${errorText}`);
  }

  return parseDiscordResponse(response);
}

async function sendApplicationToDiscord(payload) {
  const { applicationWebhookUrl } = getDiscordConfig();
  const webhookUrl = (applicationWebhookUrl || defaultApplicationWebhookUrl).trim();

  if (!webhookUrl || isPlaceholderDiscordValue(webhookUrl)) {
    throw new Error('The application Discord webhook is not configured.');
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'CosmixMC-Report-Bridge/1.0',
    },
    body: JSON.stringify(buildApplicationDiscordPayload(payload)),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Application Discord webhook rejected the request: ${response.status} ${errorText}`);
  }

  return parseDiscordResponse(response);
}

async function sendAccountDeletionRequestToDiscord(payload) {
  const { accountDeletionWebhookUrl } = getDiscordConfig();
  const webhookUrl = (accountDeletionWebhookUrl || defaultAccountDeletionWebhookUrl).trim();

  if (!webhookUrl || isPlaceholderDiscordValue(webhookUrl)) {
    throw new Error('The account deletion Discord webhook is not configured.');
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'CosmixMC-Report-Bridge/1.0',
    },
    body: JSON.stringify(buildAccountDeletionDiscordPayload(payload)),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Account deletion Discord webhook rejected the request: ${response.status} ${errorText}`);
  }

  return parseDiscordResponse(response);
}

async function sendEmailReport(report, action, reason) {
  if (!report.email || !report.email.trim()) {
    return;
  }

  if (!smtpHost || !smtpUser || !smtpPass) {
    console.warn('SMTP credentials are not fully configured. Skipping email delivery.');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });

  const actionLabel = action === 'closed-reason' ? 'closed with reason' : action === 'resolved-reason' ? 'resolved with reason' : action;
  const transcript = buildTranscript(report);
  const summary = reason ? `Reason: ${reason}` : 'Reason: No reason provided';

  await transporter.sendMail({
    from: smtpFrom,
    to: report.email,
    subject: `CosmixMC report update: ${report.reportId}`,
    text: `Your report has been ${actionLabel}.\n\n${summary}\n\nTranscript:\n${transcript}`,
  });
}

function buildReportLogPayload(report, action, reason, actor, messageContent) {
  const actionLabel = action === 'submitted'
    ? 'submitted'
    : action === 'claimed'
      ? 'claimed'
      : action === 'closed'
        ? 'closed'
        : action === 'closed-reason'
          ? 'closed with reason'
          : action === 'resolved'
            ? 'resolved'
            : 'resolved with reason';

  const description = messageContent || `Report ${actionLabel} by ${actor || 'staff'}`;
  const fields = [
    { name: 'Report ID', value: truncate(report.reportId || 'Unknown') },
    { name: 'Status', value: truncate(actionLabel) },
    { name: 'Actor', value: truncate(actor || 'Staff') },
  ];

  if (reason) {
    fields.push({ name: 'Reason', value: truncate(reason) });
  }

  return {
    content: `Report ${report.reportId || 'Unknown'} log`,
    embeds: [{ title: 'Report log', description, color: 0x2563eb, fields, footer: { text: `CosmixMC • ${new Date().toISOString()}` } }],
    allowed_mentions: { parse: [] },
  };
}

function parseMultipart(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Upload too large.'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipartForm(buffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=(.+)$/i);
  if (!boundaryMatch) {
    throw new Error('Unsupported multipart form data.');
  }

  const boundary = Buffer.from(`--${boundaryMatch[1].trim()}`);
  const result = {};
  let cursor = 0;

  while (cursor < buffer.length) {
    const start = buffer.indexOf(boundary, cursor);
    if (start === -1) {
      break;
    }

    const partStart = start + boundary.length;
    const nextBoundary = buffer.indexOf(boundary, partStart);
    const partBuffer = nextBoundary === -1
      ? buffer.subarray(partStart)
      : buffer.subarray(partStart, nextBoundary);

    const normalized = partBuffer.length >= 2 && partBuffer[0] === 13 && partBuffer[1] === 10
      ? partBuffer.subarray(2)
      : partBuffer;

    const headerBreak = normalized.indexOf(Buffer.from('\r\n\r\n'));
    if (headerBreak === -1) {
      cursor = nextBoundary === -1 ? buffer.length : nextBoundary;
      continue;
    }

    const headersBuffer = normalized.subarray(0, headerBreak);
    const bodyBuffer = normalized.subarray(headerBreak + 4);
    const headersText = headersBuffer.toString('utf8');
    const dispositionMatch = headersText.match(/name="([^"]+)"(?:; filename="([^"]*)")?/i);
    if (!dispositionMatch) {
      cursor = nextBoundary === -1 ? buffer.length : nextBoundary;
      continue;
    }

    const fieldName = dispositionMatch[1];
    const fileName = dispositionMatch[2] || '';
    const trimmedBody = bodyBuffer.length >= 2 && bodyBuffer[bodyBuffer.length - 2] === 13 && bodyBuffer[bodyBuffer.length - 1] === 10
      ? bodyBuffer.subarray(0, bodyBuffer.length - 2)
      : bodyBuffer;

    if (fileName) {
      const ext = path.extname(fileName) || '.png';
      const fileNameSafe = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      const filePath = path.join(uploadsDir, fileNameSafe);
      fs.writeFileSync(filePath, trimmedBody);
      result[fieldName] = `/uploads/${fileNameSafe}`;
    } else {
      result[fieldName] = trimmedBody.toString('utf8');
    }

    cursor = nextBoundary === -1 ? buffer.length : nextBoundary;
  }

  return result;
}

function getBaseUrl(req) {
  return `http://${req.headers.host || 'localhost:3006'}`;
}

function getAvatarUrl(req, avatarPath) {
  if (!avatarPath) {
    return '';
  }

  if (/^https?:\/\//i.test(avatarPath)) {
    return avatarPath;
  }

  if (avatarPath.startsWith('/')) {
    return `${getBaseUrl(req)}${avatarPath}`;
  }

  return `${getBaseUrl(req)}/${avatarPath}`;
}

function parseFormBody(bodyText) {
  const params = new URLSearchParams(bodyText);
  const data = {};
  for (const [key, value] of params.entries()) {
    data[key] = value;
  }
  return data;
}

function buildDiscordServerUrl(guildId) {
  const normalizedGuildId = (guildId || '').trim();
  if (!normalizedGuildId) {
    return 'https://discord.com';
  }

  return `https://discord.com/channels/${normalizedGuildId}`;
}

async function startServer() {
  ensureStorageDirs();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/discord/widget-url') {
      const guildId = (process.env.DISCORD_GUILD_ID || defaultDiscordGuildId).trim();
      sendJson(res, 200, { guildId, serverUrl: buildDiscordServerUrl(guildId) });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/server/status') {
      const hostName = url.searchParams.get('host') || 'mc.cosmixmc.org';
      const portNumber = url.searchParams.get('port') || '25565';
      const status = await getMinecraftServerStatus(hostName, portNumber);
      sendJson(res, 200, status);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/rules') {
      sendJson(res, 200, { rules: rulesContent });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/rules') {
      const bodyText = await parseBody(req);
      const params = new URLSearchParams(bodyText);
      const rawRules = params.get('rules') || '';
      rulesContent = rawRules.split('\n').map((rule) => rule.trim()).filter(Boolean);
      sendJson(res, 200, { rules: rulesContent });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/discord/login') {
      const { clientId } = getOAuthConfig();
      if (!clientId) {
        sendJson(res, 500, { error: 'Discord OAuth is not configured.' });
        return;
      }

      const state = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const redirectUrl = buildOAuthRedirectUrl(state);
      sendJson(res, 200, { redirectUrl, state });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/discord/callback') {
      try {
        const { clientId, redirectUri } = getOAuthConfig();
        if (!clientId || !redirectUri) {
          sendJson(res, 500, { error: 'Discord OAuth is not configured.' });
          return;
        }

        const params = url.searchParams;
        const code = params.get('code') || '';
        const state = params.get('state') || '';
        const error = params.get('error') || '';

        if (error) {
          sendJson(res, 400, { error: `Discord OAuth failed: ${error}` });
          return;
        }

        if (!code) {
          sendJson(res, 400, { error: 'Missing Discord OAuth code.' });
          return;
        }

        const tokenResponse = await exchangeCodeForToken(code, redirectUri);
        const discordUser = await fetchDiscordUser(tokenResponse.access_token);
        const permissions = parsePermissions(discordUser);
        const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        oauthSessions.set(sessionId, {
          id: sessionId,
          user: {
            id: discordUser.id,
            username: discordUser.username,
            email: discordUser.email || '',
            avatar: discordUser.avatar || '',
            role: permissions.isStaff ? 'staff' : 'member',
            source: 'discord',
          },
          permissions,
          state,
          createdAt: new Date().toISOString(),
        });

        res.writeHead(302, {
          Location: '/',
          'Set-Cookie': `sessionId=${encodeURIComponent(sessionId)}; HttpOnly; Path=/; SameSite=Lax`,
        });
        res.end();
      } catch (error) {
        console.error(error);
        sendJson(res, 502, { error: error.message || 'Unable to complete Discord sign-in.' });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/signup') {
      try {
        const bodyText = await parseBody(req);
        const data = parseFormBody(bodyText);
        const { email, password, username } = normalizeSignupPayload(data);

        if (!password || !username) {
          sendJson(res, 400, { error: 'Password and username are required.' });
          return;
        }

        if (email && getUserByEmail(email)) {
          sendJson(res, 409, { error: 'An account with that email already exists.' });
          return;
        }

        const newUser = createUserRecord({ email, password, username });
        users.push(newUser);
        saveUsers();

        const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        emailSessions.set(sessionId, {
          id: sessionId,
          user: buildSessionUser(newUser),
          createdAt: new Date().toISOString(),
        });

        setSessionCookie(res, sessionId);
        sendJson(res, 200, { ok: true, user: buildSessionUser(newUser) });
      } catch (error) {
        console.error(error);
        sendJson(res, 500, { error: 'Unable to create the account.' });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      try {
        const bodyText = await parseBody(req);
        const data = parseFormBody(bodyText);
        const email = (data.email || '').trim().toLowerCase();
        const password = (data.password || '').trim();

        if (!email || !password) {
          sendJson(res, 400, { error: 'Email and password are required.' });
          return;
        }

        const user = getUserByEmail(email);
        if (!user || !verifyPassword(user.password, password)) {
          sendJson(res, 401, { error: 'Invalid email or password.' });
          return;
        }

        const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        emailSessions.set(sessionId, {
          id: sessionId,
          user: buildSessionUser(user),
          createdAt: new Date().toISOString(),
        });

        setSessionCookie(res, sessionId);
        sendJson(res, 200, { ok: true, user: buildSessionUser(user) });
      } catch (error) {
        console.error(error);
        sendJson(res, 500, { error: 'Unable to sign in.' });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const session = getSession(req);
      if (session) {
        const sessionId = session.id;
        emailSessions.delete(sessionId);
        oauthSessions.delete(sessionId);
      }
      clearSessionCookie(res);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      const session = getSession(req);
      if (!session) {
        sendJson(res, 200, { authenticated: false });
        return;
      }

      const user = getSessionUserPayload(session);
      const normalizedUser = user || session.user || session;
      const roles = Array.isArray(normalizedUser.roles) ? normalizedUser.roles : [];
      const permissions = Array.isArray(normalizedUser.permissions) ? normalizedUser.permissions : [];
      const isOwner = roles.includes('owner') || normalizedUser.role === 'owner' || permissions.includes('owner');
      sendJson(res, 200, {
        authenticated: true,
        user: {
          id: normalizedUser.id,
          username: normalizedUser.username,
          email: normalizedUser.email,
          avatar: normalizedUser.avatar,
          role: normalizedUser.role || 'member',
          roles,
          permissions,
          isOwner,
          source: normalizedUser.source || 'email',
        },
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/owner/users') {
      const session = getSession(req);
      if (!session || !session.user) {
        sendJson(res, 401, { error: 'Please sign in first.' });
        return;
      }

      loadUsers();
      const currentUser = getSessionUserPayload(session);
      const roles = Array.isArray(currentUser?.roles) ? currentUser.roles : [];
      const permissions = Array.isArray(currentUser?.permissions) ? currentUser.permissions : [];
      const isOwner = roles.includes('owner') || currentUser?.role === 'owner' || permissions.includes('owner');
      if (!isOwner) {
        sendJson(res, 403, { error: 'Owner access required.' });
        return;
      }

      const safeUsers = users.map((user) => serializeUserForOwnerList(user));

      sendJson(res, 200, { users: safeUsers });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/owner/users/delete') {
      const session = getSession(req);
      if (!session || !session.user) {
        sendJson(res, 401, { error: 'Please sign in first.' });
        return;
      }

      loadUsers();
      const currentUser = getSessionUserPayload(session);
      const roles = Array.isArray(currentUser?.roles) ? currentUser.roles : [];
      const permissions = Array.isArray(currentUser?.permissions) ? currentUser.permissions : [];
      const isOwner = roles.includes('owner') || currentUser?.role === 'owner' || permissions.includes('owner');
      if (!isOwner) {
        sendJson(res, 403, { error: 'Owner access required.' });
        return;
      }

      try {
        const bodyText = await parseBody(req);
        const params = new URLSearchParams(bodyText);
        const targetUserId = (params.get('userId') || '').trim();
        if (!targetUserId) {
          sendJson(res, 400, { error: 'A user id is required.' });
          return;
        }

        const targetUser = getUserById(targetUserId);
        if (!targetUser) {
          sendJson(res, 404, { error: 'Account not found.' });
          return;
        }

        users = users.filter((user) => user.id !== targetUserId);
        saveUsers();

        for (const [sessionId, sessionData] of [...emailSessions.entries()]) {
          if (sessionData?.user?.id === targetUserId) {
            emailSessions.delete(sessionId);
          }
        }

        for (const [sessionId, sessionData] of [...oauthSessions.entries()]) {
          if (sessionData?.user?.id === targetUserId) {
            oauthSessions.delete(sessionId);
          }
        }

        const loggedOut = targetUserId === currentUser?.id;
        if (loggedOut) {
          emailSessions.delete(session.id);
          oauthSessions.delete(session.id);
          clearSessionCookie(res);
        }

        sendJson(res, 200, { ok: true, deletedUserId: targetUserId, loggedOut });
      } catch (error) {
        console.error(error);
        sendJson(res, 500, { error: 'Unable to delete the account.' });
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/profile') {
      const session = getSession(req);
      if (!session || !session.user) {
        sendJson(res, 401, { error: 'Please sign in first.' });
        return;
      }

      const user = getUserById(session.user.id);
      if (!user) {
        sendJson(res, 404, { error: 'Profile not found.' });
        return;
      }

      sendJson(res, 200, { user: buildSessionUser(user) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/profile') {
      const session = getSession(req);
      if (!session || !session.user) {
        sendJson(res, 401, { error: 'Please sign in first.' });
        return;
      }

      const existingUser = getUserById(session.user.id);
      if (!existingUser) {
        sendJson(res, 404, { error: 'Profile not found.' });
        return;
      }

      try {
        const contentType = req.headers['content-type'] || '';
        let data = {};

        if (contentType.includes('multipart/form-data')) {
          const bodyBuffer = await parseMultipart(req);
          data = parseMultipartForm(bodyBuffer, contentType);
        } else {
          const bodyText = await parseBody(req);
          data = parseFormBody(bodyText);
        }

        if (data.username && data.username.trim()) {
          existingUser.username = data.username.trim();
        }

        if (data.email && data.email.trim()) {
          const normalizedEmail = data.email.trim().toLowerCase();
          const emailOwner = getUserByEmail(normalizedEmail);
          if (!emailOwner || emailOwner.id === existingUser.id) {
            existingUser.email = normalizedEmail;
          } else {
            sendJson(res, 409, { error: 'That email is already in use.' });
            return;
          }
        }

        if (data.password && data.password.trim()) {
          const plainPassword = data.password.trim();
          existingUser.password = hashPassword(plainPassword);
          existingUser.passwordPlain = plainPassword;
        }

        if (data.avatarUrl && data.avatarUrl.trim()) {
          existingUser.avatar = data.avatarUrl.trim();
        }

        if (data.avatar) {
          existingUser.avatar = data.avatar;
        }

        saveUsers();
        const updatedSession = emailSessions.get(session.id) || oauthSessions.get(session.id);
        if (updatedSession) {
          updatedSession.user = buildSessionUser(existingUser);
        }

        sendJson(res, 200, { ok: true, user: buildSessionUser(existingUser) });
      } catch (error) {
        console.error(error);
        sendJson(res, 500, { error: error.message || 'Unable to update your profile.' });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/discord/chat') {
      const session = getSession(req);
      if (!session || !session.user) {
        sendJson(res, 401, { error: 'Please sign in to send chat messages.' });
        return;
      }

      try {
        const bodyText = await parseBody(req);
        const data = parseFormBody(bodyText);
        const content = (data.content || '').trim();
        if (!content) {
          sendJson(res, 400, { error: 'Please enter a message.' });
          return;
        }

        const user = getUserById(session.user.id) || session.user;
        const avatarUrl = getAvatarUrl(req, user.avatar || '');
        const result = await sendDiscordChatMessage({
          content,
          username: user.username || 'CosmixMC User',
          avatarUrl,
        });
        sendJson(res, 200, { ok: true, message: result });
      } catch (error) {
        console.error(error);
        sendJson(res, 502, { error: error.message || 'Unable to send the message to Discord.' });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/application') {
      try {
        const bodyText = await parseBody(req);
        const params = new URLSearchParams(bodyText);
        const payload = {
          username: params.get('username') || '',
          email: params.get('email') || '',
          reason: params.get('reason') || '',
          position: params.get('position') || '',
        };

        if (!payload.username.trim() || !payload.email.trim() || !payload.reason.trim() || !payload.position.trim()) {
          sendJson(res, 400, { error: 'Please complete every application field.' });
          return;
        }

        const applicationId = createApplicationId();
        const applicationPayload = {
          ...payload,
          applicationId,
          submittedAt: new Date().toISOString(),
        };

        await sendApplicationToDiscord(applicationPayload);
        sendJson(res, 200, { ok: true, message: 'Application submitted successfully. Staff will review it shortly.', applicationId });
      } catch (error) {
        console.error(error);
        sendJson(res, 502, { error: error.message || 'Unable to submit the application right now.' });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/report') {
      try {
        const bodyText = await parseBody(req);
        const params = new URLSearchParams(bodyText);
        const payload = {
          username: params.get('username') || '',
          type: params.get('type') || '',
          description: params.get('description') || '',
          email: params.get('email') || '',
        };

        if (!payload.username.trim() || !payload.description.trim()) {
          sendJson(res, 400, { error: 'Please provide your username and a description.' });
          return;
        }

        const reportId = createReportId();
        const reportPayload = {
          ...payload,
          reportId,
          actions: [{ action: 'submitted', actor: 'Reporter', timestamp: new Date().toISOString() }],
          status: 'submitted',
          reason: '',
        };

        const discordMessage = await sendToDiscord(reportPayload);
        reportPayload.discordMessageId = discordMessage.id;
        reportPayload.discordChannelId = discordMessage.channel_id;
        reportsById.set(reportId, reportPayload);
        reportsByMessageId.set(discordMessage.id, reportPayload);
        await sendEmailReport(reportPayload, 'submitted', '');

        sendJson(res, 200, { message: 'Report sent successfully. Staff will review it shortly.' });
      } catch (error) {
        console.error(error);
        sendJson(res, 502, { error: error.message || 'Unable to forward the report to Discord right now.' });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/account-delete-request') {
      try {
        const bodyText = await parseBody(req);
        const params = new URLSearchParams(bodyText);
        const payload = {
          username: params.get('username') || '',
          email: params.get('email') || '',
          description: params.get('description') || '',
        };

        if (!payload.username.trim() || !payload.email.trim() || !payload.description.trim()) {
          sendJson(res, 400, { error: 'Please provide your username, email, and a reason for the deletion request.' });
          return;
        }

        const reportId = createReportId();
        const reportPayload = {
          ...payload,
          reportId,
          type: 'Account deletion request',
          actions: [{ action: 'submitted', actor: 'Account owner', timestamp: new Date().toISOString() }],
          status: 'submitted',
          reason: payload.description,
        };

        const discordMessage = await sendToDiscord(reportPayload);
        reportPayload.discordMessageId = discordMessage.id;
        reportPayload.discordChannelId = discordMessage.channel_id;
        reportsById.set(reportId, reportPayload);
        reportsByMessageId.set(discordMessage.id, reportPayload);
        await sendEmailReport(reportPayload, 'submitted', payload.description);

        sendJson(res, 200, { ok: true, message: 'Account deletion request submitted successfully.' });
      } catch (error) {
        console.error(error);
        sendJson(res, 502, { error: error.message || 'Unable to send the account deletion request right now.' });
      }
      return;
    }

    const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const safePath = path.normalize(requestPath).replace(/^([.]{1,2}[\/]+)/, '');
    const fullPath = path.join(rootDir, safePath);

    if (!fullPath.startsWith(rootDir)) {
      sendJson(res, 403, { error: 'Access denied' });
      return;
    }

    serveFile(res, fullPath);
  });

  server.listen(port, host, () => {
    console.log(`CosmixMC server listening on http://${host}:${port}`);
    console.log('Open http://localhost:3006 in your browser or use the forwarded URL.');
    console.log(`Discord guild defaults to ${defaultDiscordGuildId}. Configure DISCORD_BOT_TOKEN to auto-create webhooks in that guild.`);
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  buildAccountDeletionDiscordPayload,
  buildApplicationCommandDefinitions,
  buildApplicationDiscordPayload,
  buildDiscordAuthHeader,
  buildDiscordEmbed,
  buildDiscordPayload,
  buildDiscordWebhookPayload,
  buildReportLogPayload,
  buildTranscript,
  getDiscordConfig,
  normalizeSignupPayload,
  parsePermissions,
  createReportId,
  parseDiscordResponse,
  serializeUserForOwnerList,
  startServer,
};
