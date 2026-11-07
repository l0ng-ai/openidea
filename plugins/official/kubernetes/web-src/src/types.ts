export interface ClusterContextInfo {
  name: string;
  cluster: string;
  server: string;
  user: string;
  namespace: string;
  source: string;
  short_name: string;
  version: string;
  distro: string;
  nodes?: number | null;
  last_seen: string;
  hotbar_pinned: boolean;
  hotbar_order?: number | null;
}

export interface ContainerStateBadge {
  name: string;
  state: "running" | "terminated" | "waiting" | string;
  ready: boolean;
  reason: string;
  is_init: boolean;
}

export interface ClusterResource {
  kind: string;
  name: string;
  namespace: string;
  status: string;
  ready: string;
  age: string;
  detail: string;
  containers: string[];
  ports: string[];
  data_keys: string[];
  container_states?: ContainerStateBadge[];
  cpu?: string;
  memory?: string;
  restarts?: number;
  controlled_by_kind?: string;
  controlled_by_name?: string;
  pod_ip?: string;
  host_ip?: string;
  node_name?: string;
  qos?: string;
  labels?: string[];
}

export interface ClusterEvent {
  kind: string;
  object: string;
  namespace: string;
  reason: string;
  message: string;
  event_type: string;
  count: number;
  last_seen: string;
}

export interface HelmRelease {
  name: string;
  namespace: string;
  revision: string;
  status: string;
  chart: string;
  app_version: string;
  updated: string;
}

export interface ClusterSnapshot {
  connected: boolean;
  error?: string | null;
  current_context: string;
  contexts: string[];
  cluster_catalog: ClusterContextInfo[];
  current_namespace: string;
  all_namespaces: boolean;
  namespaces: string[];
  resources: ClusterResource[];
  events: ClusterEvent[];
  helm_releases: HelmRelease[];
}

export interface WorkspaceManifest {
  kind: string;
  name: string;
  namespace: string;
  path: string;
  fullPath: string;
  line: number;
}

export interface ColumnDef {
  id: string;
  label: string;
  defaultWidth: number;
  defaultVisible: boolean;
  align?: "left" | "center" | "right";
}

declare global {
  interface Window {
    openidea: {
      postMessage(msg: string): void;
      onMessage(cb: (msg: string) => void): void;
    };
  }
}
