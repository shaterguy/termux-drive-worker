import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export class OAuthProvider {
  constructor(clientFile, tokenFile) {
    this.clientFile = clientFile;
    this.tokenFile = tokenFile;
    this.refreshing = null;
  }

  async #readJson(file) {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  }

  async accessToken(force = false) {
    const token = await this.#readJson(this.tokenFile);
    const expiresAt = Number(token.expires_at_ms || 0);
    if (!force && token.access_token && expiresAt - Date.now() > 300000) return token.access_token;
    if (!this.refreshing) this.refreshing = this.#refresh(token).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async #refresh(token) {
    if (!token.refresh_token) throw new Error('OAuth refresh_token missing');
    const client = await this.#readJson(this.clientFile);
    if (!client.client_id) throw new Error('OAuth client_id missing');
    const body = new URLSearchParams({
      client_id: String(client.client_id),
      refresh_token: String(token.refresh_token),
      grant_type: 'refresh_token',
    });
    if (client.client_secret) body.set('client_secret', String(client.client_secret));
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) throw new Error('OAuth refresh failed: ' + response.status);
    const next = {
      ...token,
      access_token: payload.access_token,
      token_type: payload.token_type || token.token_type || 'Bearer',
      scope: payload.scope || token.scope || '',
      expires_at_ms: Date.now() + Number(payload.expires_in || 3600) * 1000,
    };
    const temp = this.tokenFile + '.tmp-' + process.pid;
    await fs.writeFile(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temp, this.tokenFile);
    return next.access_token;
  }
}

export class DriveClient {
  constructor(auth, options = {}) {
    this.auth = auth;
    this.timeoutMs = Number(options.timeoutMs || 15000);
    this.retryCount = Number(options.retryCount ?? 2);
  }

  async request(url, init = {}, authRetry = true, retries = this.retryCount) {
    const access = await this.auth.accessToken(false);
    const method = String(init.method || 'GET').toUpperCase();
    const retryable = method !== 'POST';
    let response;
    try {
      response = await fetch(url, {
        ...init,
        signal: init.signal || AbortSignal.timeout(this.timeoutMs),
        headers: { ...(init.headers || {}), authorization: 'Bearer ' + access },
      });
    } catch (error) {
      if (retryable && retries > 0) return this.request(url, init, authRetry, retries - 1);
      throw error;
    }
    if (response.status === 401 && authRetry) {
      await this.auth.accessToken(true);
      return this.request(url, init, false, retries);
    }
    if ((response.status === 429 || response.status >= 500) && retryable && retries > 0) {
      try { await response.arrayBuffer(); } catch {}
      return this.request(url, init, authRetry, retries - 1);
    }
    return response;
  }

  async serverTimeMs() {
    const response = await this.request(
      API + '/files/root?' + new URLSearchParams({ fields:'id' }),
      { headers:{ 'cache-control':'no-store' } },
    );
    const raw = await response.text();
    if (!response.ok) throw new Error('Drive server-time probe failed: ' + response.status + ' ' + raw.slice(0,300));
    const observed = Date.parse(String(response.headers.get('date') || ''));
    if (!Number.isFinite(observed)) throw new Error('DRIVE_SERVER_TIME_UNAVAILABLE');
    return observed;
  }

  async listFolderPage(folderId, pageToken = null, pageSize = 100) {
    const q = "'" + folderId + "' in parents and trashed=false";
    const params = new URLSearchParams({
      q, spaces:'drive', pageSize:String(Math.max(1,Math.min(1000,Number(pageSize) || 100))),
      orderBy:'modifiedTime',
      fields:'nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink,parents)',
    });
    if (pageToken) params.set('pageToken', String(pageToken));
    const response = await this.request(API + '/files?' + params);
    const raw = await response.text();
    if (!response.ok) throw new Error('Drive list failed: ' + response.status + ' ' + raw.slice(0,300));
    const payload = JSON.parse(raw || '{}');
    return {
      files:(payload.files || []).sort(
        (x,y) => String(x.modifiedTime || '').localeCompare(String(y.modifiedTime || '')),
      ),
      nextPageToken:payload.nextPageToken || null,
    };
  }

  async listFolder(folderId) {
    const files = [];
    let pageToken = null;
    do {
      const page = await this.listFolderPage(folderId,pageToken,1000);
      files.push(...page.files);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files.sort(
      (x,y) => String(x.modifiedTime || '').localeCompare(String(y.modifiedTime || '')),
    );
  }

  async getMetadata(fileId) {
    const response = await this.request(
      API + '/files/' + encodeURIComponent(fileId) + '?' + new URLSearchParams({
        fields:'id,name,mimeType,parents,trashed',
      }),
    );
    const raw = await response.text();
    if (!response.ok) throw new Error('Drive metadata failed: ' + response.status + ' ' + raw.slice(0,300));
    return JSON.parse(raw || '{}');
  }

  async readText(file) {
    const response = await this.request(API + '/files/' + encodeURIComponent(file.id) + '?alt=media');
    const raw = await response.text();
    if (!response.ok) throw new Error('Drive read failed: ' + response.status + ' ' + raw.slice(0,300));
    return raw.replace(/^\uFEFF/, '');
  }

  async findAllByName(folderId, name) {
    const esc = String(name).replace(/'/g, "\'");
    const q = "'" + folderId + "' in parents and trashed=false and name='" + esc + "'";
    const response = await this.request(API + '/files?' + new URLSearchParams({
      q, spaces:'drive', pageSize:'1000',
      fields:'files(id,name,mimeType,modifiedTime,size,webViewLink,parents,appProperties)',
    }));
    const raw = await response.text();
    if (!response.ok) throw new Error('Drive find failed: ' + response.status + ' ' + raw.slice(0,300));
    return JSON.parse(raw || '{}').files || [];
  }

  async findByName(folderId, name) {
    const matches = await this.findAllByName(folderId,name);
    if (matches.length > 1) {
      const error = new Error('Drive name conflict: ' + folderId + '/' + name + ' matches=' + matches.length);
      error.code = 'DRIVE_NAME_CONFLICT';
      error.matches = matches.map((item) => item.id);
      throw error;
    }
    return matches[0] || null;
  }

  async findByCreateIdentity(folderId,name,identity) {
    const escName = String(name).replace(/'/g, "\'");
    const escIdentity = String(identity).replace(/'/g, "\'");
    const q = "'" + folderId + "' in parents and trashed=false and name='" + escName
      + "' and appProperties has { key='serverSyncCreateIdentity' and value='" + escIdentity + "' }";
    const response = await this.request(API + '/files?' + new URLSearchParams({
      q, spaces:'drive', pageSize:'1000',
      fields:'files(id,name,mimeType,modifiedTime,size,webViewLink,parents,appProperties)',
    }));
    const raw = await response.text();
    if (!response.ok) throw new Error('Drive identity find failed: ' + response.status + ' ' + raw.slice(0,300));
    const matches = JSON.parse(raw || '{}').files || [];
    if (matches.length > 1) {
      const error = new Error('Drive create identity conflict: ' + folderId + '/' + name + ' matches=' + matches.length);
      error.code = 'DRIVE_CREATE_IDENTITY_CONFLICT';
      error.matches = matches.map((item) => item.id);
      throw error;
    }
    return matches[0] || null;
  }

  async #readBytes(fileId) {
    const response = await this.request(API + '/files/' + encodeURIComponent(fileId) + '?alt=media');
    const raw = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      throw new Error('Drive read failed: ' + response.status + ' ' + raw.toString('utf8').slice(0,300));
    }
    return raw;
  }

  async #findVerifiedCreateCandidate(folderId, name, mimeType, bytes, identity) {
    const found = await this.findByCreateIdentity(folderId,name,identity);
    if (!found) return null;
    const expectedMime = String(mimeType || '').split(';',1)[0].trim().toLowerCase();
    const actualMime = String(found.mimeType || '').split(';',1)[0].trim().toLowerCase();
    const parents = found.parents || [];
    if (
      found.name !== name
      || actualMime !== expectedMime
      || parents.length !== 1
      || parents[0] !== folderId
    ) {
      const error = new Error('Drive create candidate metadata mismatch: ' + folderId + '/' + name);
      error.code = 'DRIVE_CREATE_CANDIDATE_MISMATCH';
      throw error;
    }
    const expected = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const actual = await this.#readBytes(found.id);
    const expectedHash = createHash('sha256').update(expected).digest('hex');
    const actualHash = createHash('sha256').update(actual).digest('hex');
    if (actualHash !== expectedHash) {
      const error = new Error('Drive create content mismatch: ' + folderId + '/' + name);
      error.code = 'DRIVE_CREATE_CONTENT_MISMATCH';
      throw error;
    }
    return found;
  }

  async #createBytes(folderId, name, mimeType, bytes) {
    const identity = createHash('sha256')
      .update(String(folderId)).update('\0')
      .update(String(name)).update('\0')
      .update(bytes)
      .digest('hex');
    for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify({
        name,
        parents:[folderId],
        appProperties:{ serverSyncCreateIdentity:identity },
      })], { type:'application/json' }));
      form.append('file', new Blob([bytes], { type:mimeType }), name);
      let response;
      try {
        response = await this.request(
          UPLOAD + '/files?uploadType=multipart&fields=id,name,mimeType,webViewLink,parents,appProperties',
          { method:'POST', body:form },
          true,
          0,
        );
      } catch (error) {
        const found = await this.#findVerifiedCreateCandidate(folderId,name,mimeType,bytes,identity);
        if (found) return found;
        if (attempt < this.retryCount) continue;
        throw error;
      }
      const raw = await response.text();
      if (response.ok) {
        const created = JSON.parse(raw || '{}');
        const found = await this.#findVerifiedCreateCandidate(folderId,name,mimeType,bytes,identity);
        if (!found || found.id !== created.id) {
          const error = new Error('Drive create readback mismatch: ' + folderId + '/' + name);
          error.code = 'DRIVE_CREATE_READBACK_MISMATCH';
          throw error;
        }
        return found;
      }
      if (response.status === 429 || response.status >= 500) {
        const found = await this.#findVerifiedCreateCandidate(folderId,name,mimeType,bytes,identity);
        if (found) return found;
        if (attempt < this.retryCount) continue;
      }
      throw new Error('Drive create failed: ' + response.status + ' ' + raw.slice(0,300));
    }
    throw new Error('Drive create failed without terminal outcome');
  }

  async #updateBytes(fileId, mimeType, bytes) {
    const response = await this.request(
      UPLOAD + '/files/' + encodeURIComponent(fileId) + '?uploadType=media',
      { method:'PATCH', headers:{ 'content-type':mimeType }, body:bytes },
    );
    const raw = await response.text();
    if (!response.ok) throw new Error('Drive update failed: ' + response.status + ' ' + raw.slice(0,300));
    return raw ? JSON.parse(raw) : { id:fileId };
  }

  async upsertJson(folderId, name, value) {
    const text = JSON.stringify(value, null, 2) + '\n';
    const found = await this.findByName(folderId, name);
    if (found) {
      await this.#updateBytes(found.id, 'application/json; charset=utf-8', text);
      return found;
    }
    return this.#createBytes(folderId, name, 'application/json; charset=utf-8', text);
  }
}

export function createDefaultDriveClient(options = {}) {
  const home = options.home || os.homedir();
  const clientFile = process.env.SERVER_SYNC_OAUTH_CLIENT_FILE
    || path.join(home, '.selfrun-server', 'drive-auth-client.json');
  const tokenFile = process.env.SERVER_SYNC_OAUTH_TOKEN_FILE
    || path.join(home, '.selfrun-server', 'drive-auth-token.json');
  return new DriveClient(new OAuthProvider(clientFile, tokenFile), options);
}
