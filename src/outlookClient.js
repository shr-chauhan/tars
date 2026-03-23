const axios = require('axios');

class OutlookClient {
  constructor() {
    this.appId     = process.env.MICROSOFT_APP_ID;
    this.appSecret = process.env.MICROSOFT_APP_PASSWORD;
    this.tenantId  = process.env.MICROSOFT_TENANT_ID;
    this.userEmail = process.env.OUTLOOK_USER_EMAIL;

    if (!this.appId)     throw new Error('MICROSOFT_APP_ID is not set');
    if (!this.appSecret) throw new Error('MICROSOFT_APP_PASSWORD is not set');
    if (!this.tenantId)  throw new Error('MICROSOFT_TENANT_ID is not set');
    if (!this.userEmail) throw new Error('OUTLOOK_USER_EMAIL is not set');

    this._token = null;
    this._tokenExpiry = 0;
  }

  // ── Auth ───────────────────────────────────────────────────────────────────

  async _getToken() {
    if (this._token && Date.now() < this._tokenExpiry - 60_000) {
      return this._token;
    }

    const url = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    const params = new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     this.appId,
      client_secret: this.appSecret,
      scope:         'https://graph.microsoft.com/.default',
    });

    const res = await axios.post(url, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    this._token = res.data.access_token;
    this._tokenExpiry = Date.now() + res.data.expires_in * 1000;
    return this._token;
  }

  async _graph(path, params = {}, extraHeaders = {}) {
    const token = await this._getToken();
    const res = await axios.get(`https://graph.microsoft.com/v1.0${path}`, {
      headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
      params,
    });
    return res.data;
  }

  // ── List emails ────────────────────────────────────────────────────────────

  async listEmails({ folder = 'inbox', limit = 10, unreadOnly = false } = {}) {
    const cap = Math.min(limit, 25);
    const params = {
      '$top': cap,
      '$select': 'id,subject,from,receivedDateTime,isRead,bodyPreview',
      '$orderby': 'receivedDateTime desc',
    };
    if (unreadOnly) params['$filter'] = 'isRead eq false';

    const data = await this._graph(
      `/users/${this.userEmail}/mailFolders/${folder}/messages`,
      params
    );

    return {
      count: data.value.length,
      emails: data.value.map(this._formatEmail),
    };
  }

  // ── Get full email ─────────────────────────────────────────────────────────

  async getEmail({ emailId }) {
    const data = await this._graph(
      `/users/${this.userEmail}/messages/${emailId}`,
      { '$select': 'id,subject,from,toRecipients,receivedDateTime,isRead,body' },
      { 'Prefer': 'outlook.body-content-type="text"' }
    );

    return {
      id: data.id,
      subject: data.subject,
      from: data.from?.emailAddress?.address,
      to: data.toRecipients?.map(r => r.emailAddress?.address),
      receivedAt: data.receivedDateTime,
      isRead: data.isRead,
      body: (data.body?.content || '').slice(0, 3000),
    };
  }

  // ── Search emails ──────────────────────────────────────────────────────────

  async searchEmails({ query, limit = 10 } = {}) {
    const cap = Math.min(limit, 25);
    const data = await this._graph(
      `/users/${this.userEmail}/messages`,
      {
        '$search': `"${query}"`,
        '$top': cap,
        '$select': 'id,subject,from,receivedDateTime,isRead,bodyPreview',
      }
    );

    return {
      count: data.value.length,
      emails: data.value.map(this._formatEmail),
    };
  }

  // ── List calendar events ───────────────────────────────────────────────────

  async listEvents({ date = null, days = 1, limit = 20 } = {}) {
    const start = date ? new Date(date) : new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + days);

    const data = await this._graph(
      `/users/${this.userEmail}/calendarView`,
      {
        startDateTime: start.toISOString(),
        endDateTime:   end.toISOString(),
        '$top': Math.min(limit, 50),
        '$select': 'id,subject,start,end,location,organizer,attendees,isOnlineMeeting,onlineMeetingUrl,bodyPreview',
        '$orderby': 'start/dateTime asc',
      }
    );

    return {
      count: data.value.length,
      events: data.value.map(e => ({
        id:           e.id,
        subject:      e.subject,
        start:        e.start?.dateTime,
        end:          e.end?.dateTime,
        location:     e.location?.displayName || null,
        organizer:    e.organizer?.emailAddress?.address,
        attendees:    e.attendees?.map(a => a.emailAddress?.address) || [],
        isOnline:     e.isOnlineMeeting,
        joinUrl:      e.onlineMeetingUrl || null,
        preview:      e.bodyPreview,
      })),
    };
  }

  // ── Formatter ──────────────────────────────────────────────────────────────

  _formatEmail(email) {
    return {
      id: email.id,
      subject: email.subject,
      from: email.from?.emailAddress?.address,
      receivedAt: email.receivedDateTime,
      isRead: email.isRead,
      preview: email.bodyPreview,
    };
  }
}

module.exports = { OutlookClient };
