import axios from 'axios';
import { ipcMain } from 'electron';
import Store from 'electron-store';
import * as fs from 'fs';
import * as path from 'path';

import { getStore } from './config';

type GomusicUploadConfig = {
  enabled: boolean;
  serverUrl: string;
  autoUpload: boolean;
  authToken: string;
};

type UploadQueueItem = {
  filePath: string;
  filename: string;
  songId: number;
  title?: string;
  artist?: string;
  retries: number;
};

const DEFAULT_CONFIG: GomusicUploadConfig = {
  enabled: true,
  serverUrl: 'http://localhost:8081',
  autoUpload: true,
  authToken: ''
};

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const UPLOAD_CONCURRENCY = 2;

class GomusicUploadManager {
  private uploadQueue: UploadQueueItem[] = [];
  private activeUploads = 0;
  private uploadedFiles = new Set<string>();

  private configStore: any = null;
  private persistStore: Store<{ uploadedFiles: string[] }>;

  constructor() {
    this.persistStore = new Store<{ uploadedFiles: string[] }>({
      name: 'gomusic-uploaded',
      defaults: { uploadedFiles: [] }
    });

    const saved = this.persistStore.get('uploadedFiles', []);
    this.uploadedFiles = new Set(saved);
  }

  initialize(): void {
    this.ensureConfigDefaults();
    this.registerIpcHandlers();
  }

  private getConfigStore() {
    if (!this.configStore) {
      this.configStore = getStore();
    }
    return this.configStore;
  }

  private ensureConfigDefaults(): void {
    const store = this.getConfigStore();
    if (!store) return;

    if (store.get('set.gomusicUploadEnabled') === undefined) {
      store.set('set.gomusicUploadEnabled', DEFAULT_CONFIG.enabled);
    }
    if (!store.get('set.gomusicUploadServerUrl')) {
      store.set('set.gomusicUploadServerUrl', DEFAULT_CONFIG.serverUrl);
    }
    if (store.get('set.gomusicUploadAuto') === undefined) {
      store.set('set.gomusicUploadAuto', DEFAULT_CONFIG.autoUpload);
    }
  }

  getConfig(): GomusicUploadConfig {
    const store = this.getConfigStore();
    return {
      enabled: Boolean(store?.get('set.gomusicUploadEnabled') ?? DEFAULT_CONFIG.enabled),
      serverUrl: String(store?.get('set.gomusicUploadServerUrl') ?? DEFAULT_CONFIG.serverUrl),
      autoUpload: Boolean(store?.get('set.gomusicUploadAuto') ?? DEFAULT_CONFIG.autoUpload),
      authToken: String(store?.get('set.gomusicUploadAuthToken') ?? DEFAULT_CONFIG.authToken)
    };
  }

  updateConfig(partial: Partial<GomusicUploadConfig>): GomusicUploadConfig {
    const store = this.getConfigStore();
    if (!store) return this.getConfig();

    if (partial.enabled !== undefined) store.set('set.gomusicUploadEnabled', partial.enabled);
    if (partial.serverUrl !== undefined) store.set('set.gomusicUploadServerUrl', partial.serverUrl);
    if (partial.autoUpload !== undefined) store.set('set.gomusicUploadAuto', partial.autoUpload);
    if (partial.authToken !== undefined) store.set('set.gomusicUploadAuthToken', partial.authToken);

    return this.getConfig();
  }

  queueUpload(filePath: string, songId: number, title?: string, artist?: string): void {
    const config = this.getConfig();
    if (!config.enabled || !config.autoUpload) return;

    if (!config.authToken) {
      console.warn(
        `[GomusicUpload] 未登录 GoMusic-Node，跳过上传: ${path.basename(filePath)}。请在设置中登录。`
      );
      return;
    }

    if (!fs.existsSync(filePath)) {
      console.warn(`[GomusicUpload] 文件不存在，跳过: ${filePath}`);
      return;
    }

    const fileKey = `${songId}_${path.basename(filePath)}`;
    if (this.uploadedFiles.has(fileKey)) {
      return;
    }

    const existing = this.uploadQueue.find((item) => item.filePath === filePath);
    if (existing) return;

    const filename = this.buildFilename(filePath, title, artist);

    this.uploadQueue.push({
      filePath,
      filename,
      songId,
      title,
      artist,
      retries: 0
    });

    console.log(`[GomusicUpload] 队列添加: ${filename} (歌曲ID: ${songId})`);

    this.processQueue();
  }

  private buildFilename(filePath: string, title?: string, artist?: string): string {
    const ext = path.extname(filePath);
    if (title) {
      const sanitized = title
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
      const artistPart = artist
        ? ` - ${artist
            .replace(/[<>:"/\\|?*]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()}`
        : '';
      return `${sanitized}${artistPart}${ext}`;
    }
    return path.basename(filePath);
  }

  private async processQueue(): Promise<void> {
    while (this.uploadQueue.length > 0 && this.activeUploads < UPLOAD_CONCURRENCY) {
      const item = this.uploadQueue.shift();
      if (!item) break;

      if (!fs.existsSync(item.filePath)) {
        continue;
      }

      const fileKey = `${item.songId}_${path.basename(item.filePath)}`;
      if (this.uploadedFiles.has(fileKey)) {
        continue;
      }

      this.activeUploads++;

      this.uploadFile(item)
        .then((success) => {
          if (success) {
            this.uploadedFiles.add(fileKey);
            this.persistUploadedFiles();
            console.log(`[GomusicUpload] 上传成功: ${item.filename}`);
          }
        })
        .catch((err) => {
          const errMsg = err?.response?.data?.msg || err?.message || String(err);
          console.error(`[GomusicUpload] 上传失败: ${item.filename} - ${errMsg}`);

          if (item.retries < MAX_RETRIES) {
            item.retries++;
            setTimeout(() => {
              this.uploadQueue.push(item);
              this.processQueue();
            }, RETRY_DELAY_MS);
          }
        })
        .finally(() => {
          this.activeUploads--;
          this.processQueue();
        });
    }
  }

  private async uploadFile(item: UploadQueueItem): Promise<boolean> {
    const config = this.getConfig();
    if (!config.serverUrl) {
      throw new Error('GoMusic-Node 服务器地址未配置');
    }

    const serverUrl = config.serverUrl.replace(/\/+$/, '');
    const authHeaders: Record<string, string> = {};
    if (config.authToken) {
      authHeaders['Authorization'] = `Bearer ${config.authToken}`;
    }

    // 检查文件是否已存在
    try {
      const checkRes = await axios.post(
        `${serverUrl}/api/upload/check`,
        { filename: item.filename },
        { timeout: 10000, headers: authHeaders }
      );

      if (checkRes.data?.data?.exists) {
        console.log(`[GomusicUpload] 文件已存在于Alist，跳过: ${item.filename}`);
        return true;
      }
    } catch {
      // 检查失败不阻止上传
    }

    // 从 GoMusic-Node 获取 Alist 直传凭证
    const { alistServerUrl, token, uploadPath } = await this.getDirectCredentials(serverUrl);

    // 直接上传到 Alist 服务器
    const fileBuffer = fs.readFileSync(item.filePath);
    const remoteDir = uploadPath || '/music';
    const targetPath = remoteDir.endsWith('/')
      ? remoteDir + item.filename
      : remoteDir + '/' + item.filename;
    const encodedPath = Buffer.from(targetPath, 'utf-8').toString('latin1');

    try {
      await axios.put(`${alistServerUrl}/api/fs/put`, fileBuffer, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'File-Path': encodedPath,
          Authorization: token,
          'Content-Length': fileBuffer.length
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120000
      });
    } catch (err: any) {
      const errMsg = (err?.response?.data?.message || '').toLowerCase();
      if (errMsg.includes('token') && (errMsg.includes('invalid') || errMsg.includes('expir'))) {
        console.log('[GomusicUpload] Alist Token 过期，重新获取凭证...');
        const creds = await this.getDirectCredentials(serverUrl, true);
        const retryTargetPath = (creds.uploadPath || '/music').endsWith('/')
          ? creds.uploadPath + item.filename
          : creds.uploadPath + '/' + item.filename;
        await axios.put(`${creds.alistServerUrl}/api/fs/put`, fileBuffer, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'File-Path': Buffer.from(retryTargetPath, 'utf-8').toString('latin1'),
            Authorization: creds.token,
            'Content-Length': fileBuffer.length
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: 120000
        });
      } else {
        throw err;
      }
    }

    return true;
  }

  private async getDirectCredentials(
    serverUrl: string,
    forceRefresh = false
  ): Promise<{ alistServerUrl: string; token: string; uploadPath: string }> {
    const config = this.getConfig();
    const url = forceRefresh
      ? `${serverUrl}/api/upload/direct-credentials?refresh=1`
      : `${serverUrl}/api/upload/direct-credentials`;

    const headers: Record<string, string> = {};
    if (config.authToken) {
      headers['Authorization'] = `Bearer ${config.authToken}`;
    }

    try {
      const res = await axios.get(url, { timeout: 10000, headers });
      const data = res.data?.data;
      if (!data?.serverUrl || !data?.token) {
        throw new Error(res.data?.msg || '获取 Alist 直传凭证失败');
      }
      return {
        alistServerUrl: data.serverUrl,
        token: data.token,
        uploadPath: data.uploadPath || '/music'
      };
    } catch (err: any) {
      const msg = err?.response?.data?.msg || err?.message || '未知错误';
      // 如果是 Alist 登录失败，给出更清晰的提示
      if (msg.includes('unsuccessful sign-in') || msg.includes('incorrect username or password')) {
        throw new Error(
          'Alist 登录失败：用户名或密码错误，请在 GoMusic-Node 网页上更新 Alist 配置'
        );
      }
      if (msg.includes('请先登录') || err?.response?.status === 401) {
        throw new Error('GoMusic-Node 登录已过期，请在设置中重新登录');
      }
      throw new Error(`获取凭证失败: ${msg}`);
    }
  }

  private persistUploadedFiles(): void {
    const arr = Array.from(this.uploadedFiles).slice(-5000);
    this.persistStore.set('uploadedFiles', arr);
  }

  clearUploadedHistory(): void {
    this.uploadedFiles.clear();
    this.persistStore.set('uploadedFiles', []);
  }

  getQueueStatus(): {
    pending: number;
    active: number;
    uploaded: number;
  } {
    return {
      pending: this.uploadQueue.length,
      active: this.activeUploads,
      uploaded: this.uploadedFiles.size
    };
  }

  private registerIpcHandlers(): void {
    ipcMain.handle('gomusic-upload:get-config', () => this.getConfig());

    ipcMain.handle('gomusic-upload:update-config', (_, partial: Partial<GomusicUploadConfig>) =>
      this.updateConfig(partial)
    );

    ipcMain.handle('gomusic-upload:get-status', () => this.getQueueStatus());

    ipcMain.handle('gomusic-upload:clear-history', () => this.clearUploadedHistory());

    ipcMain.handle(
      'gomusic-upload:upload-file',
      async (
        _,
        payload: {
          filePath: string;
          songId: number;
          title?: string;
          artist?: string;
        }
      ) => {
        this.queueUpload(payload.filePath, payload.songId, payload.title, payload.artist);
        return true;
      }
    );

    // GoMusic 登录
    ipcMain.handle(
      'gomusic-upload:login',
      async (_, serverUrl: string, username: string, password: string) => {
        const url = `${serverUrl.replace(/\/+$/, '')}/api/auth/login`;
        const res = await axios.post(url, { username, password }, { timeout: 10000 });
        if (res.data?.code === 1 && res.data?.data?.token) {
          this.updateConfig({
            serverUrl: serverUrl.replace(/\/+$/, ''),
            authToken: res.data.data.token
          });
          console.log(`[GomusicUpload] 登录成功: ${username}, token 已保存`);
          return { success: true, user: res.data.data.user, token: res.data.data.token };
        }
        throw new Error(res.data?.msg || '登录失败');
      }
    );

    // GoMusic 注册
    ipcMain.handle(
      'gomusic-upload:register',
      async (_, serverUrl: string, username: string, password: string) => {
        const url = `${serverUrl.replace(/\/+$/, '')}/api/auth/register`;
        const res = await axios.post(url, { username, password }, { timeout: 10000 });
        if (res.data?.code === 1 && res.data?.data?.token) {
          this.updateConfig({
            serverUrl: serverUrl.replace(/\/+$/, ''),
            authToken: res.data.data.token
          });
          return { success: true, user: res.data.data.user, token: res.data.data.token };
        }
        throw new Error(res.data?.msg || '注册失败');
      }
    );

    // GoMusic 获取用户信息
    ipcMain.handle('gomusic-upload:profile', async () => {
      const config = this.getConfig();
      if (!config.serverUrl || !config.authToken) {
        throw new Error('未登录');
      }
      const url = `${config.serverUrl.replace(/\/+$/, '')}/api/auth/profile`;
      const res = await axios.get(url, {
        timeout: 10000,
        headers: { Authorization: `Bearer ${config.authToken}` }
      });
      if (res.data?.code === 1) {
        return res.data.data;
      }
      throw new Error(res.data?.msg || '获取用户信息失败');
    });

    // GoMusic 登出
    ipcMain.handle('gomusic-upload:logout', () => {
      this.updateConfig({ authToken: '' });
      return true;
    });

    // GoMusic 获取歌单列表
    ipcMain.handle('gomusic-upload:playlists', async () => {
      const config = this.getConfig();
      if (!config.serverUrl || !config.authToken) {
        throw new Error('未登录');
      }
      const url = `${config.serverUrl.replace(/\/+$/, '')}/api/playlists`;
      const res = await axios.get(url, {
        timeout: 10000,
        headers: { Authorization: `Bearer ${config.authToken}` }
      });
      if (res.data?.code === 1) {
        return res.data.data;
      }
      throw new Error(res.data?.msg || '获取歌单失败');
    });

    // GoMusic 获取单个歌单
    ipcMain.handle('gomusic-upload:playlist-detail', async (_, playlistId: number) => {
      const config = this.getConfig();
      if (!config.serverUrl || !config.authToken) {
        throw new Error('未登录');
      }
      const url = `${config.serverUrl.replace(/\/+$/, '')}/api/playlists/${playlistId}`;
      const res = await axios.get(url, {
        timeout: 10000,
        headers: { Authorization: `Bearer ${config.authToken}` }
      });
      if (res.data?.code === 1) {
        return res.data.data;
      }
      throw new Error(res.data?.msg || '获取歌单详情失败');
    });
  }
}

const gomusicUploadManager = new GomusicUploadManager();

export function initializeGomusicUpload(): void {
  gomusicUploadManager.initialize();
}

export function queueGomusicUpload(
  filePath: string,
  songId: number,
  title?: string,
  artist?: string
): void {
  gomusicUploadManager.queueUpload(filePath, songId, title, artist);
}

export function getGomusicUploadManager(): GomusicUploadManager {
  return gomusicUploadManager;
}
