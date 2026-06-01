<template>
  <div class="custom-playlist-page h-full flex flex-col">
    <div class="flex items-center justify-between px-6 py-4 flex-shrink-0 animate__fadeInLeft">
      <div class="flex items-center gap-4">
        <div>
          <h2 class="text-2xl font-bold text-gray-900 dark:text-white">🎵 自定义歌单</h2>
          <p class="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            从 GoMusic-Node 服务器同步的歌单
          </p>
        </div>
      </div>

      <div class="flex items-center gap-3">
        <div
          class="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium"
          :class="
            wsConnected
              ? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400'
              : 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400'
          "
        >
          <div
            class="w-2 h-2 rounded-full"
            :class="wsConnected ? 'bg-green-500' : 'bg-red-500'"
          ></div>
          {{ wsConnected ? '已连接' : '未连接' }}
        </div>

        <div
          class="flex items-center bg-gray-100 dark:bg-neutral-800 rounded-lg overflow-hidden h-9"
        >
          <input
            v-model="serverUrl"
            type="text"
            placeholder="服务器地址"
            class="h-full px-3 text-xs bg-transparent border-none outline-none w-40 text-gray-700 dark:text-gray-300"
            @keydown.enter="connectToServer"
          />
          <button
            class="h-full px-3 text-xs font-medium transition-colors"
            :class="
              wsConnected
                ? 'bg-red-500 text-white hover:bg-red-600'
                : 'bg-primary text-white hover:bg-primary/80'
            "
            @click="wsConnected ? disconnectWs() : connectToServer()"
          >
            {{ wsConnected ? '断开' : '连接' }}
          </button>
        </div>

        <button
          class="h-9 px-4 rounded-full bg-primary/10 hover:bg-primary text-primary hover:text-white text-xs font-medium transition-all duration-300 flex items-center gap-1.5"
          @click="fetchPlaylists"
        >
          <i class="ri-refresh-line text-sm"></i>
          刷新歌单
        </button>
      </div>
    </div>

    <n-scrollbar class="flex-1 px-6">
      <div v-if="loading" class="flex justify-center items-center py-20">
        <n-spin size="large" />
      </div>

      <div
        v-else-if="playlists.length === 0"
        class="flex flex-col items-center justify-center py-20 text-gray-400"
      >
        <i class="ri-music-2-line text-6xl mb-4"></i>
        <p class="text-lg">暂无歌单</p>
        <p class="text-sm mt-2">请在 GoMusic-Node 中导入歌单后刷新</p>
      </div>

      <div v-else class="space-y-4 pb-6">
        <div
          v-for="pl in playlists"
          :key="pl.id"
          class="bg-white dark:bg-neutral-900 rounded-2xl overflow-hidden border border-gray-100 dark:border-neutral-800 shadow-sm hover:shadow-md transition-all"
        >
          <div
            class="flex items-center justify-between px-5 py-4 cursor-pointer"
            @click="toggleExpand(pl.id)"
          >
            <div class="flex items-center gap-3">
              <div
                class="w-10 h-10 rounded-xl flex items-center justify-center"
                :class="
                  pl.source === 'qqmusic'
                    ? 'bg-blue-100 dark:bg-blue-900/30'
                    : 'bg-red-100 dark:bg-red-900/30'
                "
              >
                <i
                  class="text-lg"
                  :class="
                    pl.source === 'qqmusic'
                      ? 'ri-qq-line text-blue-500'
                      : 'ri-netease-cloud-music-line text-red-500'
                  "
                ></i>
              </div>
              <div>
                <h3 class="text-base font-semibold text-gray-900 dark:text-white">
                  {{ pl.name }}
                </h3>
                <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {{ pl.songs_count }} 首 · {{ new Date(pl.created_at).toLocaleDateString() }}
                </p>
              </div>
            </div>

            <div class="flex items-center gap-2" @click.stop>
              <button
                class="h-8 px-3 rounded-full bg-primary/10 hover:bg-primary text-primary hover:text-white text-xs font-medium transition-all flex items-center gap-1"
                @click="playAll(pl)"
              >
                <i class="ri-play-fill"></i>
                播放全部
              </button>
              <i
                class="ri-arrow-down-s-line text-lg text-gray-400 transition-transform duration-300"
                :class="{ 'rotate-180': expandedIds.has(pl.id) }"
              ></i>
            </div>
          </div>

          <div
            v-if="expandedIds.has(pl.id)"
            class="border-t border-gray-100 dark:border-neutral-800"
          >
            <div v-if="pl.songs.length === 0" class="px-5 py-6 text-center text-sm text-gray-400">
              歌单为空
            </div>
            <div v-else class="divide-y divide-gray-50 dark:divide-neutral-800/50">
              <div
                v-for="(song, idx) in pl.songs"
                :key="idx"
                class="flex items-center gap-3 px-5 py-2.5 hover:bg-gray-50 dark:hover:bg-neutral-800/50 cursor-pointer group transition-colors"
                @click="playSong(song)"
              >
                <span class="w-7 text-right text-xs text-gray-400 flex-shrink-0">{{
                  idx + 1
                }}</span>
                <div class="flex-1 min-w-0">
                  <p
                    class="text-sm text-gray-900 dark:text-white truncate group-hover:text-primary transition-colors"
                  >
                    {{ parseSongName(song) }}
                  </p>
                  <p class="text-xs text-gray-400 truncate">{{ parseArtist(song) }}</p>
                </div>
                <i
                  class="ri-play-fill text-primary opacity-0 group-hover:opacity-100 transition-opacity"
                ></i>
              </div>
            </div>
          </div>
        </div>
      </div>
    </n-scrollbar>
  </div>
</template>

<script lang="ts" setup>
import { useMessage } from 'naive-ui';
import { onMounted, onUnmounted, ref, watch } from 'vue';

import { getSearch } from '@/api/search';
import { playTrack } from '@/services/playbackController';
import { usePlayerStore } from '@/store/modules/player';
import type { SongResult } from '@/types/music';

const message = useMessage();
const playerStore = usePlayerStore();

const serverUrl = ref('https://play.suay.cn/');
const wsConnected = ref(false);
const loading = ref(false);
const playlists = ref<any[]>([]);
const expandedIds = ref(new Set<number>());

const PLACEHOLDER_PREFIX = '__custom_placeholder__';
const resolvingSet = new Set<string>();

function makePlaceholderId(songStr: string): string {
  return `${PLACEHOLDER_PREFIX}${songStr}`;
}

function isPlaceholder(song: any): boolean {
  return String(song.id).startsWith(PLACEHOLDER_PREFIX);
}

function placeholderToSongStr(song: any): string {
  return String(song.id).slice(PLACEHOLDER_PREFIX.length);
}

function makePlaceholderSong(songStr: string): SongResult {
  const songName = parseSongName(songStr);
  const artist = parseArtist(songStr);
  return {
    id: makePlaceholderId(songStr),
    name: songName,
    picUrl: '',
    ar: artist ? [{ id: 0, name: artist }] : ([] as any),
    al: { id: 0, name: '', picUrl: '' } as any,
    source: 'netease',
    count: 0
  };
}

async function resolvePlaceholder(songStr: string): Promise<SongResult | null> {
  const songName = parseSongName(songStr);
  const artist = parseArtist(songStr);
  const keyword = artist ? `${songName} ${artist}` : songName;

  try {
    const { data } = await getSearch({ keywords: keyword, type: 1, limit: 1 });
    const songs = data?.result?.songs;
    if (songs && songs.length > 0) {
      const song = songs[0];
      return {
        id: song.id,
        name: song.name,
        picUrl: song.al?.picUrl || '',
        ar: (song.ar || []).map((a: any) => ({ id: a.id, name: a.name })) as any,
        al: {
          id: song.al?.id || 0,
          name: song.al?.name || '',
          picUrl: song.al?.picUrl || ''
        } as any,
        source: 'netease',
        count: 0
      };
    }
  } catch {
    console.error('搜索失败:', keyword);
  }
  return null;
}

async function resolveInList(song: SongResult): Promise<SongResult | null> {
  if (!isPlaceholder(song)) return song;

  const pid = String(song.id);
  if (resolvingSet.has(pid)) return null;
  resolvingSet.add(pid);

  const songStr = placeholderToSongStr(song);
  const realSong = await resolvePlaceholder(songStr);

  resolvingSet.delete(pid);

  if (realSong) {
    const list = [...playerStore.playList];
    const idx = list.findIndex((s: SongResult) => String(s.id) === pid);
    if (idx !== -1) {
      list[idx] = realSong;
      playerStore.setPlayList(list, true);
    }
    return realSong;
  }

  const list = [...playerStore.playList];
  const idx = list.findIndex((s: SongResult) => String(s.id) === pid);
  if (idx !== -1) {
    list.splice(idx, 1);
    playerStore.setPlayList(list, true);
  }
  return null;
}

function preloadAround(currentIndex: number) {
  const list = playerStore.playList;
  if (!list || list.length === 0) return;

  const indices: number[] = [];
  if (currentIndex + 1 < list.length) indices.push(currentIndex + 1);
  if (currentIndex + 2 < list.length) indices.push(currentIndex + 2);
  if (currentIndex - 1 >= 0) indices.push(currentIndex - 1);

  for (const i of indices) {
    if (isPlaceholder(list[i])) {
      resolveInList(list[i]);
    }
  }
}

let stopWatch: (() => void) | null = null;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsRetryCount = 0;
const WS_MAX_RETRIES = 5;

function parseSongName(songStr: string): string {
  const parts = songStr.split(' - ');
  return parts[0]?.trim() || songStr;
}

function parseArtist(songStr: string): string {
  const parts = songStr.split(' - ');
  return parts.length > 1 ? parts.slice(1).join(' - ').trim() : '';
}

function toggleExpand(id: number) {
  if (expandedIds.value.has(id)) {
    expandedIds.value.delete(id);
  } else {
    expandedIds.value.add(id);
  }
}

async function fetchPlaylists() {
  try {
    const config = await window.api.gomusicUploadGetConfig();
    if (!config?.authToken) {
      message.warning('请先在设置中登录 GoMusic 账号');
      return;
    }
  } catch {
    message.warning('请先在设置中登录 GoMusic 账号');
    return;
  }
  loading.value = true;
  try {
    const data = await window.api.gomusicPlaylists();
    playlists.value = data || [];
  } catch (e: any) {
    const msg = e?.message || '获取歌单失败';
    message.error(msg);
    if (msg.includes('过期') || msg.includes('未登录')) {
      wsConnected.value = false;
    }
  } finally {
    loading.value = false;
  }
}

async function searchAndPlay(songName: string, artist: string) {
  const keyword = artist ? `${songName} ${artist}` : songName;

  try {
    const { data } = await getSearch({ keywords: keyword, type: 1, limit: 5 });
    const songs = data?.result?.songs;

    if (songs && songs.length > 0) {
      const song = songs[0];
      const songResult: SongResult = {
        id: song.id,
        name: song.name,
        picUrl: song.al?.picUrl || '',
        ar: (song.ar || []).map((a: any) => ({ id: a.id, name: a.name })) as any,
        al: {
          id: song.al?.id || 0,
          name: song.al?.name || '',
          picUrl: song.al?.picUrl || ''
        } as any,
        source: 'netease',
        count: 0
      };

      await playTrack(songResult, true);
    } else {
      message.warning(`未找到: ${keyword}`);
    }
  } catch {
    message.error(`搜索失败: ${keyword}`);
  }
}

function playSong(songStr: string) {
  const songName = parseSongName(songStr);
  const artist = parseArtist(songStr);
  searchAndPlay(songName, artist);
}

async function playAll(pl: any) {
  if (pl.songs.length === 0) return;

  const placeholderList: SongResult[] = pl.songs.map((s: string) => makePlaceholderSong(s));
  playerStore.setPlayList(placeholderList, false);

  const firstSong = placeholderList[0];
  const realSong = await resolveInList(firstSong);
  if (realSong) {
    preloadAround(0);
    await playTrack(realSong, true);
    message.success(`已加载歌单「${pl.name}」，共 ${pl.songs.length} 首，播放时自动搜索`);
  } else {
    playerStore.nextPlay();
  }
}

function connectToServer() {
  if (ws) {
    ws.close();
    ws = null;
  }

  const wsProtocol = serverUrl.value.startsWith('https') ? 'wss:' : 'ws:';
  const wsHost = serverUrl.value.replace(/^https?:/, wsProtocol);
  const wsUrl = `${wsHost}/ws`;

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      wsConnected.value = true;
      wsRetryCount = 0;
      localStorage.setItem('gomusic-server-url', serverUrl.value);
      message.success('已连接到 GoMusic-Node 服务器');
      ws?.send(JSON.stringify({ type: 'register', device: 'AlgerMusicPlayer' }));
      fetchPlaylists();
    };

    ws.onclose = () => {
      wsConnected.value = false;
      ws = null;
      if (wsRetryCount < WS_MAX_RETRIES) {
        wsRetryCount++;
        reconnectTimer = setTimeout(connectToServer, 3000);
      }
    };

    ws.onerror = () => {
      wsConnected.value = false;
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);

        if (msg.type === 'play_song') {
          const { songName, artist } = msg.data;
          searchAndPlay(songName, artist);
        }

        if (msg.type === 'player_control') {
          const { action } = msg.data;
          if (action === 'togglePlay') {
            if (playerStore.play && playerStore.playMusic?.id) {
              playerStore.handlePause();
            } else if (playerStore.playMusic?.id) {
              playerStore.setPlay({ ...playerStore.playMusic });
            }
          } else if (action === 'prevPlay') {
            playerStore.prevPlay();
          } else if (action === 'nextPlay') {
            playerStore.nextPlay();
          } else if (action === 'volumeUp') {
            playerStore.increaseVolume();
          } else if (action === 'volumeDown') {
            playerStore.decreaseVolume();
          }
        }

        if (msg.type === 'play_playlist') {
          const { playlistId } = msg.data;
          const pl = playlists.value.find((p: any) => p.id === playlistId);
          if (pl && pl.songs.length > 0) {
            playSong(pl.songs[0]);
          }
        }
      } catch (err) {
        console.error('WebSocket 消息处理失败:', err);
      }
    };
  } catch {
    message.error('连接失败，请检查服务器地址');
  }
}

function disconnectWs() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
  wsConnected.value = false;
  message.info('已断开连接');
}

onMounted(async () => {
  // 从 electron-store 配置中读取服务器地址
  try {
    const config = await window.api.gomusicUploadGetConfig();
    if (config?.serverUrl) {
      serverUrl.value = config.serverUrl;
    }
    // 如果已登录，自动加载歌单并连接 WebSocket
    if (config?.authToken) {
      fetchPlaylists();
      connectToServer();
    }
  } catch {
    // 未配置，使用默认值
    const saved = localStorage.getItem('gomusic-server-url');
    if (saved) serverUrl.value = saved;
  }

  const stopWatcher = watch(
    () => playerStore.playMusic?.id,
    () => {
      const list = playerStore.playList;
      if (!list || list.length === 0) return;

      const currentId = playerStore.playMusic?.id;
      const currentIdx = list.findIndex((s: SongResult) => String(s.id) === String(currentId));
      if (currentIdx >= 0) {
        preloadAround(currentIdx);
      }

      if (playerStore.playMusic && isPlaceholder(playerStore.playMusic)) {
        resolveInList(playerStore.playMusic).then((realSong) => {
          if (realSong) {
            playTrack(realSong, true);
          } else {
            playerStore.nextPlay();
          }
        });
      }
    }
  );

  stopWatch = stopWatcher;
});

onUnmounted(() => {
  if (stopWatch) stopWatch();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) ws.close();
});
</script>

<style lang="scss" scoped>
.custom-playlist-page {
  animation-duration: 0.3s !important;
}
</style>
