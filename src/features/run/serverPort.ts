/**
 * The HTTP port of a running web application from its startup line:
 * Spring Boot ("Tomcat started on port 8080 (http)…", Netty, Undertow, Jetty),
 * Vite ("➜  Local:   http://localhost:5173/") and Vue CLI ("- Local:   http://localhost:8080/").
 */
const STARTED = /\b(?:Tomcat|Netty|Undertow|Jetty)\b.*?\bstarted on port(?:\(s\))?:?\s*(\d{1,5})/i;
const DEV_SERVER = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})\//;

const valid = (port: number) => (port > 0 && port < 65536 ? port : null);

export function startedPort(line: string): number | null {
  // Spring Boot's embedded web server: "Tomcat started on port 8080 …".
  if (line.includes("tarted on port")) {
    const m = STARTED.exec(line);
    if (m) return valid(Number(m[1]));
  }
  // A dev server's Local URL; the "Local" check skips Vite's Network line.
  if (!line.includes("Local")) return null;
  const m = DEV_SERVER.exec(line);
  return m ? valid(Number(m[1])) : null;
}
