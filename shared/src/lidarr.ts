/** `POST /setup/lidarr/test`. Omit `apiKey` to test with the saved key (editing in Settings). */
export interface LidarrTestRequest {
  url: string;
  apiKey?: string;
}

export interface LidarrProfile {
  id: number;
  name: string;
}

export interface LidarrRootFolder {
  path: string;
  /** Bytes, when Lidarr reports it. */
  freeSpace: number | null;
  defaultQualityProfileId: number | null;
  defaultMetadataProfileId: number | null;
}

/** A successful connection test, with everything the default dropdowns need. */
export interface LidarrOptions {
  version: string;
  qualityProfiles: LidarrProfile[];
  metadataProfiles: LidarrProfile[];
  rootFolders: LidarrRootFolder[];
}

/**
 * Which albums to monitor when a whole artist is added: the latest album
 * (the default, a gentle start for discovery), everything, or none of the
 * existing ones. Future releases are monitored in every case.
 */
export type ArtistMonitorChoice = 'latest' | 'all' | 'future';

/** Defaults applied when Offbeat adds an artist. */
export interface LidarrDefaults {
  qualityProfileId: number;
  metadataProfileId: number;
  rootFolderPath: string;
  /** Monitor artists added as a whole (album adds always monitor just that album). Default true. */
  addMonitored?: boolean;
  /** With `addMonitored`, which albums of a newly added artist to monitor. Default 'latest'. */
  addMonitorAlbums?: ArtistMonitorChoice;
  /** Ask Lidarr to search for what was just added. Default true. */
  searchOnAdd?: boolean;
  /** Lidarr tag applied to everything Offbeat adds, or null for none. */
  addTag?: string | null;
}

/** `POST /setup/lidarr` and `PUT /settings/lidarr`. Omit `apiKey` to keep the saved one. */
export interface LidarrSettingsRequest extends LidarrDefaults {
  url: string;
  apiKey?: string;
}

/** What the browser may see of the saved settings. The API key never leaves the server. */
export interface LidarrSettingsView extends Required<LidarrDefaults> {
  url: string;
}
