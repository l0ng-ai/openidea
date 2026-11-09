//! Parsing of recorded `docker … --format '{{json .}}'` output.

use ide_docker::{
    parse_container_stats, parse_container_top, parse_containers, parse_image_history, parse_images, parse_networks,
    parse_volumes,
};

const PS: &str = include_str!("fixtures/ps.jsonl");
const IMAGES: &str = include_str!("fixtures/images.jsonl");
const VOLUMES: &str = include_str!("fixtures/volumes.jsonl");
const NETWORKS: &str = include_str!("fixtures/networks.jsonl");

#[test]
fn containers_with_compose_labels() {
    let c = parse_containers(PS);
    assert_eq!(c.len(), 2, "non-JSON lines are skipped");
    let db = &c[0];
    assert_eq!(db.name, "shop-db-1");
    assert_eq!(db.state, "running");
    assert!(db.running());
    assert_eq!(db.status, "Up 2 hours (healthy)");
    assert_eq!(db.command, "docker-entrypoint.sh postgres");
    assert_eq!(db.compose_project.as_deref(), Some("shop"));
    assert_eq!(db.compose_service.as_deref(), Some("db"));
    assert_eq!(db.compose_working_dir.as_deref(), Some("/work/shop"));
    assert_eq!(db.compose_files, ["/work/shop/compose.yaml", "/work/shop/compose.override.yaml"]);
    assert_eq!(db.ports, "0.0.0.0:5432->5432/tcp");
    assert_eq!(db.mounts, ["shop_pgdata"]);
    assert_eq!(db.networks, ["shop_default"]);
    assert_eq!(db.labels.get("com.docker.compose.project").map(String::as_str), Some("shop"));

    let web = &c[1];
    assert_eq!(web.name, "web", "leading slash of legacy names is dropped");
    assert!(!web.running());
    assert_eq!(web.compose_project, None);
    assert!(web.mounts.is_empty());
    assert_eq!(web.networks, ["bridge"]);
}

#[test]
fn images_sorted_with_dangling_last() {
    let i = parse_images(IMAGES);
    let refs: Vec<String> = i.iter().map(|i| i.reference()).collect();
    assert_eq!(refs, ["nginx:1.27", "postgres:16", "aaaaaaaaaaaa"]);
    assert_eq!(i[1].size, "431MB");
    assert_eq!(i[1].created_since, "7 weeks ago");
}

#[test]
fn volumes_and_networks() {
    let v = parse_volumes(VOLUMES);
    assert_eq!(v.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(), ["0a1b", "shop_pgdata"]);
    assert_eq!(v[1].compose_project.as_deref(), Some("shop"));
    assert_eq!(v[1].mountpoint, "/var/lib/docker/volumes/shop_pgdata/_data");
    assert_eq!(v[1].scope, "local");
    assert_eq!(v[1].labels.get("com.docker.compose.volume").map(String::as_str), Some("pgdata"));

    let n = parse_networks(NETWORKS);
    assert_eq!(n.iter().map(|n| n.name.as_str()).collect::<Vec<_>>(), ["bridge", "host", "shop_default"]);
    assert_eq!(n[2].compose_project.as_deref(), Some("shop"));
    assert_eq!(n[1].driver, "host");
    assert!(!n[2].ipv6);
    assert!(!n[2].internal);
    assert_eq!(n[2].labels.get("com.docker.compose.network").map(String::as_str), Some("default"));
}

#[test]
fn image_history_top_and_stats() {
    let history = [
        r#"{"Comment":"buildkit.dockerfile.v0","CreatedAt":"2026-10-01 09:00:00 +0000 UTC","CreatedBy":"CMD [\"postgres\"]","CreatedSince":"5 weeks ago","ID":"sha256:1234567890ab","Size":"0B"}"#,
        r#"{"Comment":"","CreatedAt":"2026-10-01 08:59:00 +0000 UTC","CreatedBy":"/bin/sh -c #(nop) COPY file:abc in /usr/local/bin/ ","CreatedSince":"5 weeks ago","ID":"<missing>","Size":"42.5MB"}"#,
    ]
    .join("\n");
    let layers = parse_image_history(&history);
    assert_eq!(layers.len(), 2);
    assert_eq!(layers[0].created_by, "CMD [\"postgres\"]");
    assert_eq!(layers[1].size, "42.5MB");

    let top = "UID                 PID                 PPID                C                   STIME               TTY                 TIME                CMD\nroot                1234                1200                0                   09:12               ?                   00:00:01            postgres -c config_file=/etc/postgresql.conf\n";
    let parsed_top = parse_container_top(top);
    assert_eq!(parsed_top.titles, ["UID", "PID", "PPID", "C", "STIME", "TTY", "TIME", "CMD"]);
    assert_eq!(parsed_top.processes.len(), 1);
    assert_eq!(parsed_top.processes[0][0], "root");
    assert_eq!(parsed_top.processes[0][1], "1234");
    assert_eq!(parsed_top.processes[0][7], "postgres -c config_file=/etc/postgresql.conf");

    let stats_line = r#"{"BlockIO":"1.2MB / 0B","CPUPerc":"1.25%","Container":"shop-db-1","ID":"4f2b8c1d9e0a","MemPerc":"2.50%","MemUsage":"50MiB / 2GiB","Name":"shop-db-1","NetIO":"12kB / 8kB","PIDs":"14"}"#;
    let stats = parse_container_stats(stats_line).expect("stats parsed");
    assert_eq!(stats.cpu_perc, "1.25%");
    assert_eq!(stats.mem_usage, "50MiB / 2GiB");
    assert_eq!(stats.mem_perc, "2.50%");
    assert_eq!(stats.net_io, "12kB / 8kB");
    assert_eq!(stats.block_io, "1.2MB / 0B");
    assert_eq!(stats.pids, "14");
}
