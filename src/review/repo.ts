/** Read-only view of a repository tree. Node uses the real filesystem; the Durable Object uses a virtual one. */
export type RepoFileKind = "file" | "directory" | "symlink" | "other";

export type RepoStat = {
  kind: RepoFileKind;
  size: number;
};

export type RepoDirent = {
  name: string;
  kind: RepoFileKind;
};

export interface RepoFs {
  /** Canonical absolute path. Follows symlinks. Throws when the path does not exist. */
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<RepoStat>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readdir(path: string): Promise<RepoDirent[]>;
}
