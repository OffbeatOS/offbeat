/**
 * Where Offbeat reads one of Lidarr's root folders. Lidarr's paths are its
 * own (inside its container); Offbeat may see the same folder elsewhere.
 */
export interface MusicFolder {
  /** The root folder as Lidarr knows it, for example /music. */
  lidarrPath: string;
  /** Where Offbeat reads it. The same as lidarrPath unless mapped. */
  offbeatPath: string;
  /** True when an admin set offbeatPath; false when it is lidarrPath unchanged. */
  mapped: boolean;
}

/** `PUT /settings/music-files`. A folder left out (or mapped to itself) is read at Lidarr's path. */
export interface MusicFilesInput {
  folders: { lidarrPath: string; offbeatPath: string }[];
}

/** One file or folder Offbeat could not read, in plain words. */
export interface MusicFileProblem {
  lidarrPath: string;
  offbeatPath: string | null;
  reason: string;
}

/** `POST /settings/music-files/check`: can Offbeat read the folders, and a sample of files in them? */
export interface MusicFilesCheck {
  at: string;
  ok: boolean;
  folders: { lidarrPath: string; offbeatPath: string; readable: boolean; reason: string | null }[];
  /** A sample of track files across the library. */
  files: { checked: number; readable: number; problems: MusicFileProblem[] };
}

/** `GET /settings/music-files`. */
export interface MusicFilesView {
  folders: MusicFolder[];
  lastCheck: MusicFilesCheck | null;
  /** ffmpeg's version, for formats the browser cannot play; null when Offbeat cannot find it. */
  ffmpeg: string | null;
}
