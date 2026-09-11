export type ReaderReadingState = {
  progress: number;
  atStart: boolean;
  atEnd: boolean;
  loading: boolean;
  direction?: "ltr" | "rtl";
  visiblePages?: number[];
  totalPages?: number;
};
