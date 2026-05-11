// Ambient declarations for the Spotify Web Playback SDK script loaded in
// `index.html`. We declare only the slice of the API we actually consume.
// See https://developer.spotify.com/documentation/web-playback-sdk

declare global {
  interface Window {
    Spotify?: typeof SpotifyNS;
    onSpotifyWebPlaybackSDKReady?: () => void;
  }

  namespace SpotifyNS {
    interface PlayerInit {
      name: string;
      getOAuthToken: (cb: (token: string) => void) => void;
      volume?: number;
    }

    interface PlayerTrack {
      id: string | null;
      uri: string;
      name: string;
      duration_ms: number;
    }

    interface PlayerStateContextTrackWindow {
      current_track: PlayerTrack;
    }

    interface PlayerState {
      paused: boolean;
      position: number;
      duration: number;
      track_window: PlayerStateContextTrackWindow;
      timestamp: number;
    }

    interface ErrorEvent {
      message: string;
    }

    interface ReadyEvent {
      device_id: string;
    }

    type EventListener<E> = (event: E) => void;

    class Player {
      constructor(init: PlayerInit);
      connect(): Promise<boolean>;
      disconnect(): void;
      addListener(event: 'ready', cb: EventListener<ReadyEvent>): boolean;
      addListener(event: 'not_ready', cb: EventListener<ReadyEvent>): boolean;
      addListener(
        event: 'player_state_changed',
        cb: EventListener<PlayerState | null>,
      ): boolean;
      addListener(
        event:
          | 'initialization_error'
          | 'authentication_error'
          | 'account_error'
          | 'playback_error',
        cb: EventListener<ErrorEvent>,
      ): boolean;
      removeListener(event: string): void;
      getCurrentState(): Promise<PlayerState | null>;
      setName(name: string): Promise<void>;
      setVolume(volume: number): Promise<void>;
      pause(): Promise<void>;
      resume(): Promise<void>;
      togglePlay(): Promise<void>;
      seek(positionMs: number): Promise<void>;
    }
  }
}

export {};
