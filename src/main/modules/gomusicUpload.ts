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
  autoUpload: true
};

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const UPLOAD_CONCURRENCY = 2;

class GomusicUploadManager {
  private uploadQueue: UploadQueueItem[] = [];
  private activeUploads = 0;
  private uploadedFiles = new Set<string>();
  private configStore: Store | null = null;
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

  private getConfigStore(): Store | null {
    if (!this.configStore) {
      this.configStore = getStore() || null;
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
      autoUpload: Boolean(store?.get('set.gomusicUploadAuto') ?? DEFAULT_CONFIG.autoUpload)
    };
  }

  updateConfig(partial: Partial<GomusicUploadConfig>): GomusicUploadConfig {
    const store = this.getConfigStore();
    if (!store) return this.getConfig();

    if (partial.enabled !== undefined) store.set('set.gomusicUploadEnabled', partial.enabled);
    if (partial.serverUrl !== undefined)
      store.set('set.gomusicUploadServerUrl', partial.serverUrl);
    if (partial.autoUpload !== undefined) store.set('set.gomusicUploadAuto', partial.autoUpload);

    return this.getConfig();
  }

  queueUpload(
    filePath: string,
    songId: number,
    title?: string,
    artist?: string
  ): void {
    const config = this.getConfig();
    if (!config.enabled || !config.autoUpload) return;

    if (!fs.existsSync(filePath)) {
      console.warn(`[GomusicUpload] 文件不存在，跳过: ${filePath}`);
      return;
    }

    const fileKey = `${songId}_${path.basename(filePath)}`;
    if (this.uploadedFiles.has(fileKey)) {
      return;
    }

    const existing = this.uploadQueue.find(
      (item) => item.filePath === filePath
    );
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

    console.log(
      `[GomusicUpload] 队列添加: ${filename} (歌曲ID: ${songId})`
    );

    this.processQueue();
  }

  private buildFilename(
    filePath: string,
    title?: string,
    artist?: string
  ): string {
    const ext = path.extname(filePath);
    if (title) {
      const sanitized = title
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
      const artistPart = artist
        ? ` - ${artist.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim()}`
        : '';
      return `${sanitized}${artistPart}${ext}`;
    }
    return path.basename(filePath);
  }

  private async processQueue(): Promise<void> {
    while (
      this.uploadQueue.length > 0 &&
      this.activeUploads < UPLOAD_CONCURRENCY
    ) {
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
            console.log(
              `[GomusicUpload] 上传成功: ${item.filename}`
            );
          }
        })
        .catch((err) => {
          console.error(
            `[GomusicUpload] 上传失败: ${item.filename} - ${err.message}`
          );

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

    try {
      const checkRes = await axios.post(
        `${serverUrl}/api/upload/check`,
        { filename: item.filename },
        { timeout: 10000 }
      );

      if (checkRes.data?.data?.exists) {
        console.log(
          `[GomusicUpload] 文件已存在于Alist，跳过: ${item.filename}`
        );
        return true;
      }
    } catch {
      // 检查失败不阻止上传
    }

    const fileBuffer = fs.readFileSync(item.filePath);

    const encodedFilename = Buffer.from(item.filename, 'utf-8').toString('latin1');

    await axios.post(`${serverUrl}/api/upload/buffer`, fileBuffer, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-filename': encodedFilename,
        'Content-Length': fileBuffer.length
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120000
    });

    return true;
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
    ipcMain.handle(
      'gomusic-upload:get-config',
      () => this.getConfig()
    );

    ipcMain.handle(
      'gomusic-upload:update-config',
      (_, partial: Partial<GomusicUploadConfig>) =>
        this.updateConfig(partial)
    );

    ipcMain.handle(
      'gomusic-upload:get-status',
      () => this.getQueueStatus()
    );

    ipcMain.handle(
      'gomusic-upload:clear-history',
      () => this.clearUploadedHistory()
    );

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
        this.queueUpload(
          payload.filePath,
          payload.songId,
          payload.title,
          payload.artist
        );
        return true;
      }
    );
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
