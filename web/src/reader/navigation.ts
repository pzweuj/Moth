export type ReaderNavigationItem = {
  id: string;
  label: string;
  depth?: number;
  thumbnailUrl?: string;
};

export type ReaderNavigationRequest = {
  id: string;
  token: number;
};
