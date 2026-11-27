/**
 * The HTTP port of a running Spring Boot application, from the embedded web
 * server's startup line: "Tomcat started on port 8080 (http) with context path '/'",
 * "Netty started on port 8080", "Undertow started on port(s) 8080 (http)",
 * "Jetty started on port(s) 8080 (http/1.1)".
 */
const STARTED = /\b(?:Tomcat|Netty|Undertow|Jetty)\b.*?\bstarted on port(?:\(s\))?:?\s*(\d{1,5})/i;

export function startedPort(line: string): number | null {
  if (!line.includes("tarted on port")) return null;
  const m = STARTED.exec(line);
  if (!m) return null;
  const port = Number(m[1]);
  return port > 0 && port < 65536 ? port : null;
}
