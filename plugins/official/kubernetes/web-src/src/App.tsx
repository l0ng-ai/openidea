import React, { useEffect, useMemo, useRef, useState } from "react";
import { PodTerminal, dispatchPtyEvent } from "./PodTerminal";
import { ResourceDetails, cpuUnitsToNumber, unitsToBytes } from "./ResourceDetails";
import type {
  ClusterContextInfo,
  ClusterEvent,
  ClusterResource,
  ClusterSnapshot,
  ColumnDef,
  ContainerStateBadge,
  WorkspaceManifest,
} from "./types";

const AVATAR_PALETTE = [
  "#a855f7",
  "#0d9488",
  "#2563eb",
  "#b91c1c",
  "#15803d",
  "#1d4ed8",
  "#c2410c",
  "#db2777",
  "#0369a1",
  "#4f46e5",
];

function avatarColor(name: string): string {
  let h = 2166136261;
  const s = String(name || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

function shortBadge(c?: Partial<ClusterContextInfo> | string): string {
  if (typeof c === "object" && c && c.short_name) return c.short_name;
  const name = typeof c === "string" ? c : String((c && c.name) || "");
  const parts = name.split(/[-_./]+/).filter(Boolean);
  if (parts.length >= 3) return (parts[0][0] + parts[1][0] + parts[2][0]).toUpperCase();
  if (parts.length === 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 3).toUpperCase();
}

/** Converts an ISO timestamp (`2026-10-31T00:30:56Z`) or duration string (`6d22h`) into compact Freelens Age (`6d22h`, `20h`, `45m`). */
function formatCompactAge(raw?: string): string {
  if (!raw) return "-";
  if (/^\d+[smhd](\d+[smhd])?$/.test(raw.trim())) return raw.trim();
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return raw;
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  if (days >= 10) return `${days}d`;
  if (days >= 1) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours >= 1) return mins > 0 && hours < 10 ? `${hours}h${mins}m` : `${hours}h`;
  if (mins >= 1) return `${mins}m`;
  return `${diffSec}s`;
}

/** Formats an ISO timestamp for the Detail Drawer `Created` row in America/Los_Angeles (PDT/PST) like Freelens (`6d 22h 8m ago (2026-10-30 17:30:56 PDT)`). */
function formatCreatedDetailed(raw?: string): string {
  if (!raw) return "-";
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return raw;
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins}m`);
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short",
    });
    const p = Object.fromEntries(dtf.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
    const formatted = `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${p.timeZoneName || "PT"}`;
    return `${parts.join(" ")} ago (${formatted})`;
  } catch {
    return `${parts.join(" ")} ago (${raw})`;
  }
}

interface SidebarGroup {
  id: string;
  label: string;
  leafKind?: string;
  items?: Array<{ kind: string; label: string }>;
}

function SidebarIcon({ id }: { id: string }) {
  switch (id) {
    case "favorites":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
        </svg>
      );
    case "cluster":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="m22.1 14.3c-.1 0-.1 0 0 0-.1 0-.1 0-.2 0s-.3 0-.4 0-.1 0-.2 0c-.4 0-.8-.1-1.1-.2-.1-.1-.2-.1-.2-.2l-.3-.1c.1-.9.1-1.9-.1-2.8-.3-1.1-.6-2-1.2-2.8l.2-.2c0-.1 0-.2.1-.3.3-.3.6-.4.9-.7.1 0 .1-.1.2-.1.1-.1.2-.1.3-.2 0 0 .1 0 .1-.1.3-.2.3-.6.1-.9-.1-.1-.3-.2-.5-.2s-.3.1-.4.2-.1.1-.1.1c-.1.1-.2.2-.3.3 0 0-.1.1-.1.1-.3.3-.5.5-.8.7 0 .1 0 .1-.1.1h-.1l-.2.2c-.3-.3-.5-.5-.8-.8-1.2-.9-2.7-1.5-4.2-1.7v-.3c-.1-.1-.1-.1-.2-.3 0-.3 0-.7.1-1.1 0-.1 0-.1 0-.2s0-.2.1-.4v-.1c0-.4-.3-.7-.6-.7-.2 0-.3.1-.4.2s-.2.3-.2.5v.1c0 .1 0 .3.1.4v.2c0 .4.1.8.1 1.1 0 .1-.1.2-.2.3v.3c-.4 0-.7.1-1.1.2-1.8.3-3.1 1.1-4.2 2.2l-.2-.2h-.1c-.1 0-.1 0-.2-.1-.3-.1-.6-.3-.8-.6s-.1-.1-.1-.1c-.2-.2-.2-.3-.3-.4 0 0-.1 0-.1-.1-.2-.1-.4-.1-.5-.1-.2 0-.4.1-.5.2-.2.2-.1.6.2.9s.1.1.1.1c.1.1.2.1.3.2.1 0 .1.1.2.1.4.2.7.4.9.6.1.1.1.2.1.3l.2.2c0 .1-.1.1-.1.2-1 1.6-1.4 3.5-1.1 5.3l-.3.1c0 .1-.1.2-.2.2-.3.1-.7.2-1.1.2-.1 0-.1 0-.2 0s-.2 0-.4 0h-.1s0 0-.1 0c-.4.1-.6.4-.5.7s.3.5.6.5h.2.1c.1 0 .2-.1.4-.1.1 0 .1-.1.2-.1.4-.1.7-.3 1-.3.1 0 .2.1.3.1h.3c.5 1.5 1.4 2.8 2.6 3.8.3.2.6.4.9.6l-.1.3c0 .1.1.2 0 .3-.1.3-.3.6-.5.9 0 .1-.1.1-.1.2-.1.1-.1.2-.2.3 0 0 0 .1-.1.1-.2.3 0 .7.3.9.1 0 .2.1.2.1.2 0 .5-.2.6-.4s0-.1.1-.1c.1-.1.1-.2.1-.4 0-.1 0-.1.1-.2.1-.4.2-.7.4-1 .2-.1.3-.1.3-.2l.1-.3c.9.3 1.8.5 2.8.5.6 0 1.2-.1 1.7-.2.4-.1.7-.2 1-.3l.1.2c.1 0 .2.1.3.2.2.3.3.6.4 1 0 .1 0 .1.1.2 0 .1.1.2.1.4 0 0 0 .1.1.1.1.2.4.4.6.4.1 0 .2 0 .2-.1.1-.1.3-.2.3-.4s0-.3 0-.5 0-.1-.1-.1c-.1-.1-.1-.2-.2-.3 0-.1-.1-.1-.1-.2-.2-.3-.4-.6-.5-.9 0-.1 0-.2 0-.3l.1-.2c1.1-.6 2-1.5 2.6-2.6.4-.6.6-1.2.8-1.8h.2c.1 0 .1-.1.3-.1.3 0 .7.2 1 .3.1 0 .1.1.2.1.1.1.2.1.4.1h.1.1.2c.3 0 .6-.2.6-.5.1-.1-.1-.4-.4-.5zm-9.3-1-.9.4-.9-.4-.2-.9.6-.8h1l.6.8zm5.2-2.1c.2.7.2 1.4.1 2l-3.1-.9c-.3-.1-.4-.4-.4-.6 0-.1.1-.2.1-.2l2.4-2.2c.5.6.7 1.2.9 1.9zm-1.7-3.1-2.6 1.9c-.2.1-.5.1-.7-.1-.1-.1-.1-.1-.1-.2l-.2-3.3c1.4.1 2.6.7 3.6 1.7zm-5.8-1.7c.2 0 .4-.1.6-.1l-.2 3.2c0 .3-.2.5-.5.5-.1 0-.2 0-.2-.1l-2.7-1.8c.8-.8 1.8-1.4 3-1.7zm-4 2.9 2.4 2.1c.2.2.2.5.1.7-.1.1-.1.1-.2.2l-3.1.9c-.2-1.3.1-2.7.8-3.9zm-.5 5.4 3.2-.5c.3 0 .5.2.6.4v.3l-1.2 2.9c-1.2-.6-2.1-1.8-2.6-3.1zm7.3 4c-.5.1-.9.2-1.4.2-.7 0-1.4-.1-2-.3l1.6-2.9c.2-.2.4-.3.6-.1.1.1.2.1.2.2l1.5 2.8c-.1 0-.3.1-.5.1zm3.9-2.8c-.5.8-1.2 1.4-1.9 1.9l-1.3-3c-.1-.2 0-.5.3-.6.1 0 .2-.1.3-.1l3.2.5c-.1.5-.3.9-.6 1.3z" />
        </svg>
      );
    case "nodes":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="m8.7 4v16h6.7v-16zm3.3 13.3c-.3 0-.6-.3-.6-.6s.3-.6.6-.6.6.3.6.6-.3.6-.6.6zm2-6.8h-4v-1.2h4zm0-2.4h-4v-1.2h4z" />
          <path d="m16.6 5.1v13.8h6.2v-13.8zm2.9 11.2c-.3 0-.6-.3-.6-.6s.3-.6.6-.6.6.3.6.6-.1.6-.6.6zm1.7-4.9h-3.2v-1.3h3.2zm0-2.4h-3.2v-1.3h3.2z" />
          <path d="m1.2 5.1v13.8h6.2v-13.8zm3.3 11.2c-.3 0-.6-.3-.6-.6s.3-.7.6-.7.6.3.6.6-.3.7-.6.7zm1.5-4.9h-3.2v-1.3h3.2zm0-2.4h-3.2v-1.3h3.2z" />
        </svg>
      );
    case "workloads":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="m12 7.47 4.25-2.47-4.25-2.44-4.25 2.44z" />
          <path d="m11.66 8.06-4.25-2.46v4.91l4.25 2.49z" />
          <path d="m12.34 8.06v4.94l4.25-2.45v-4.95z" />
          <path d="m16.93 15.94 4.26-2.45-4.26-2.49-4.25 2.45z" />
          <path d="m16.59 16.53-4.25-2.45v4.92l4.25 2.46z" />
          <path d="m17.26 16.53v4.91l4.26-2.44v-4.93z" />
          <path d="m7.07 15.94 4.25-2.45-4.25-2.49-4.25 2.49z" />
          <path d="m6.74 16.53-4.26-2.46v4.93l4.26 2.46z" />
          <path d="m7.41 16.53v4.91l4.25-2.44v-4.93z" />
        </svg>
      );
    case "config":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z" />
        </svg>
      );
    case "network":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M17 16l-4-4V8.82C14.16 8.4 15 7.3 15 6c0-1.66-1.34-3-3-3S9 4.34 9 6c0 1.3.84 2.4 2 2.82V12l-4 4H3v5h5v-3.05l4-4.2 4 4.2V21h5v-5h-4z" />
        </svg>
      );
    case "storage":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M2 20h20v-4H2v4zm2-3h2v2H4v-2zM2 4v4h20V4H2zm4 3H4V5h2v2zm-4 7h20v-4H2v4zm2-3h2v2H4v-2z" />
        </svg>
      );
    case "namespaces":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9l-9-7-9 7 1.63 1.27L12 16z" />
        </svg>
      );
    case "events":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z" />
        </svg>
      );
    case "helm":
      return (
        <svg width="18" height="18" viewBox="0 0 500 500" fill="currentColor" aria-hidden="true">
          <path d="M136.53,121.13c-.57-.54-1.19-1.13-1.81-1.72-12.62-12.12-22.38-26.14-28.28-42.7-1.65-4.64-2.9-9.37-2.68-14.36.02-.47.02-.95.05-1.42.45-6.45,4.76-9.7,11.06-8.18a27.33,27.33,0,0,1,5.73,2.2c6.89,3.46,12.51,8.56,17.67,14.17a112.53,112.53,0,0,1,21.72,33.43,8.3,8.3,0,0,0,.39.86c.07.13.22.21.56.52A176.36,176.36,0,0,1,241.97,79.07c-.18-.88-.28-1.55-.45-2.2a112.49,112.49,0,0,1-2.65-36.96,84.07,84.07,0,0,1,4.44-21.76,31.33,31.33,0,0,1,5.48-10.17,15.69,15.69,0,0,1,3.16-2.82,7.03,7.03,0,0,1,8.03-.06,17.28,17.28,0,0,1,5.84,6.73A53.05,53.05,0,0,1,271.09,26.51a112.5,112.5,0,0,1,2.12,33,95.6,95.6,0,0,1-3.49,19.91c7.12,1.31,14.21,2.33,21.15,3.98a186.38,186.38,0,0,1,20.44,6,188.32,188.32,0,0,1,19.77,8.57c6.35,3.16,12.39,6.94,18.72,10.54.21-.43.5-.95.71-1.5A108.66,108.66,0,0,1,383.4,60.25a37.76,37.76,0,0,1,11.82-6.88,17.25,17.25,0,0,1,3.68-.85c6.26-.72,8.89,3.22,9.36,7.93a29.94,29.94,0,0,1-.77,10.35A87.91,87.91,0,0,1,396.75,95.49c-6.79,10.97-14.85,20.85-25.09,28.83-.3.24-.57.52-1.08.99a177.78,177.78,0,0,1,26.59,30.88,10.96,10.96,0,0,1-1.69.3c-10.6.02-21.19-.02-31.79.05a4,4,0,0,1-3.17-1.69,147.88,147.88,0,0,0-88.18-46.55,143.36,143.36,0,0,0-30.28-1.17,146.41,146.41,0,0,0-82.54,31.81,140.07,140.07,0,0,0-16.98,15.84,4.73,4.73,0,0,1-3.86,1.76c-10.12-.07-20.24-.04-30.36-.03h-2.15c.62-2.41,6.84-10.94,13.88-18.55C125.31,132.27,130.88,126.88,136.53,121.13Z" />
          <path d="M394.53,347.91a176.64,176.64,0,0,1-23.97,27.16c.71.59,1.29,1.07,1.86,1.55A108.31,108.31,0,0,1,406.1,424.77a34.62,34.62,0,0,1,2.2,14.42,14.89,14.89,0,0,1-.75,3.69,7.21,7.21,0,0,1-8.16,5.02,22.23,22.23,0,0,1-6.76-2.01,51.23,51.23,0,0,1-9.18-5.82,107.59,107.59,0,0,1-32.94-46.71c-.19-.51-.39-1.02-.72-1.88a194.65,194.65,0,0,1-25.01,14.01,181.67,181.67,0,0,1-26.69,9.72,187.56,187.56,0,0,1-28.3,5.39c.17.84.26,1.51.44,2.16a109.17,109.17,0,0,1,2.97,36.44,80.8,80.8,0,0,1-4.42,22.48,78.25,78.25,0,0,1-4.16,8.74,13.39,13.39,0,0,1-2.34,2.97c-3.98,4.11-8.73,4.14-12.61-.07a27.28,27.28,0,0,1-3.91-5.62c-3.08-5.78-4.66-12.06-5.79-18.46a116.86,116.86,0,0,1-1.36-26.47,94.48,94.48,0,0,1,2.88-19.19c.14-.53.27-1.07.37-1.61.03-.14-.06-.3-.17-.74a176.12,176.12,0,0,1-80.97-24.99c-.41.91-.76,1.67-1.1,2.45a110.48,110.48,0,0,1-30.9,41.42,38.16,38.16,0,0,1-12.05,6.96,12.09,12.09,0,0,1-6.52.7,7.12,7.12,0,0,1-5.4-4.49c-1.42-3.42-1.17-6.99-.68-10.52a55.45,55.45,0,0,1,4.31-14.25A112.5,112.5,0,0,1,134.89,380.78c.46-.43.93-.86,1.38-1.3a3.76,3.76,0,0,0,.37-.66,178.9,178.9,0,0,1-28.47-31.32c.98-.08,1.64-.18,2.3-.18,10.51-.01,21.03.03,31.54-.04a4.71,4.71,0,0,1,3.7,1.63,146.95,146.95,0,0,0,39.4,28.88,139.95,139.95,0,0,0,49.7,14.77q70.68,6.87,121.6-42.85a7.65,7.65,0,0,1,5.99-2.44c9.8.12,19.61.05,29.41.05h2.53Z" />
          <path d="M350.74,197.76c2.79,0,5.47.19,8.11-.05,3-.27,5.14.8,7.32,2.81,12.61,11.62,25.36,23.1,38.06,34.63.64.58,1.29,1.14,2.11,1.87.76-.66,1.48-1.24,2.16-1.87q19.64-17.88,39.25-35.79a5.45,5.45,0,0,1,4.2-1.65c3.22.13,6.45.04,9.84.04V303.13c-1.72.5-24.88.6-27.64.06v-53.36l-.54-.25c-9.01,8.22-18.02,16.44-27.24,24.84-9.23-8.31-18.34-16.52-27.46-24.74l-.52.19c-.02,4.45-.01,8.91-.01,13.36q0,6.64,0,13.28v26.87h-27.43C350.45,301.61,350.21,203.72,350.74,197.76Z" />
          <path d="M97.63,197.88h27.26c.55,1.75.66,102.97.09,105.53H97.7c-.15-6.7-.05-13.38-.07-20.06-.02-6.62,0-13.25,0-20.04H63.85V303.05c-2.06.62-25.33.67-27.65.12V197.89H63.74v37.19c1.97.57,30.92.67,33.87.13.01-2.98.02-6.03.02-9.08q.01-4.74,0-9.49,0-4.63,0-9.25C97.63,204.32,97.63,201.24,97.63,197.88Z" />
          <path d="M157.58,303.37V198.19c1.62-.53,61.55-.74,65.46-.2v22.41c-.88.06-1.79.18-2.69.18q-16.01.02-32.02.01l-2.97,0v17.43H218.71V261.22H185.66c-.55,1.99-.71,15.82-.26,19.65.84.06,1.75.17,2.66.17q16.01.02,32.02.01h2.97V303.37Z" />
          <path d="M254.28,303.41c-.5-2.82-.4-103.6.1-105.52h27.16v77.76c1.17.06,2.09.15,3.01.15q16.13.01,32.26.01c.93,0,1.85,0,2.91,0v27.6Z" />
        </svg>
      );
    case "access":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z" />
        </svg>
      );
    case "crd":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z" />
        </svg>
      );
    default:
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z" />
        </svg>
      );
  }
}

const SIDEBAR_TREE: SidebarGroup[] = [
  {
    id: "favorites",
    label: "Favorites",
    items: [{ kind: "WorkloadsOverview", label: "Overview" }],
  },
  {
    id: "cluster",
    label: "Cluster",
    leafKind: "ClusterOverview",
  },
  {
    id: "nodes",
    label: "Nodes",
    leafKind: "Node",
  },
  {
    id: "workloads",
    label: "Workloads",
    items: [
      { kind: "WorkloadsOverview", label: "Overview" },
      { kind: "Pod", label: "Pods" },
      { kind: "Deployment", label: "Deployments" },
      { kind: "DaemonSet", label: "Daemon Sets" },
      { kind: "StatefulSet", label: "Stateful Sets" },
      { kind: "ReplicaSet", label: "Replica Sets" },
      { kind: "ReplicationController", label: "Replication Controllers" },
      { kind: "Job", label: "Jobs" },
      { kind: "CronJob", label: "Cron Jobs" },
    ],
  },
  {
    id: "config",
    label: "Config",
    items: [
      { kind: "ConfigMap", label: "Config Maps" },
      { kind: "Secret", label: "Secrets" },
      { kind: "ResourceQuota", label: "Resource Quotas" },
      { kind: "LimitRange", label: "Limit Ranges" },
      { kind: "HorizontalPodAutoscaler", label: "Horizontal Pod Autoscalers" },
      { kind: "PodDisruptionBudget", label: "Pod Disruption Budgets" },
      { kind: "PriorityClass", label: "Priority Classes" },
      { kind: "RuntimeClass", label: "Runtime Classes" },
      { kind: "Lease", label: "Leases" },
      { kind: "MutatingWebhookConfiguration", label: "Mutating Webhook Configs" },
      { kind: "ValidatingWebhookConfiguration", label: "Validating Webhook Configs" },
    ],
  },
  {
    id: "network",
    label: "Network",
    items: [
      { kind: "Service", label: "Services" },
      { kind: "Endpoints", label: "Endpoints" },
      { kind: "EndpointSlice", label: "Endpoint Slices" },
      { kind: "Ingress", label: "Ingresses" },
      { kind: "IngressClass", label: "Ingress Classes" },
      { kind: "NetworkPolicy", label: "Network Policies" },
    ],
  },
  {
    id: "storage",
    label: "Storage",
    items: [
      { kind: "PersistentVolumeClaim", label: "Persistent Volume Claims" },
      { kind: "PersistentVolume", label: "Persistent Volumes" },
      { kind: "StorageClass", label: "Storage Classes" },
    ],
  },
  {
    id: "namespaces",
    label: "Namespaces",
    leafKind: "Namespace",
  },
  {
    id: "events",
    label: "Events",
    leafKind: "Event",
  },
  {
    id: "helm",
    label: "Helm",
    items: [{ kind: "HelmRelease", label: "Releases" }],
  },
  {
    id: "access",
    label: "Access Control",
    items: [
      { kind: "ServiceAccount", label: "Service Accounts" },
      { kind: "ClusterRole", label: "Cluster Roles" },
      { kind: "Role", label: "Roles" },
      { kind: "ClusterRoleBinding", label: "Cluster Role Bindings" },
      { kind: "RoleBinding", label: "Role Bindings" },
    ],
  },
  {
    id: "crd",
    label: "Custom Resources",
    items: [{ kind: "CustomResourceDefinition", label: "Definitions" }],
  },
  {
    id: "catalog",
    label: "Catalog & Workspace",
    items: [
      { kind: "ClusterCatalog", label: "Clusters" },
      { kind: "Workspace", label: "Workspace YAML" },
    ],
  },
];

const POD_COLUMNS: ColumnDef[] = [
  { id: "name", label: "Name", defaultWidth: 230, defaultVisible: true },
  { id: "warning", label: "⚠", defaultWidth: 38, defaultVisible: true, align: "center" },
  { id: "namespace", label: "Namespace", defaultWidth: 120, defaultVisible: true },
  { id: "containers", label: "Containers", defaultWidth: 105, defaultVisible: true },
  { id: "cpu", label: "CPU", defaultWidth: 80, defaultVisible: true, align: "right" },
  { id: "memory", label: "Memory", defaultWidth: 95, defaultVisible: true, align: "right" },
  { id: "restarts", label: "Restarts", defaultWidth: 80, defaultVisible: true },
  { id: "controlled_by", label: "Controlled By", defaultWidth: 125, defaultVisible: true },
  { id: "ip", label: "IP", defaultWidth: 120, defaultVisible: false },
  { id: "node", label: "Node", defaultWidth: 190, defaultVisible: false },
  { id: "qos", label: "QoS", defaultWidth: 95, defaultVisible: false },
  { id: "age", label: "Age", defaultWidth: 80, defaultVisible: true },
  { id: "status", label: "Status", defaultWidth: 105, defaultVisible: true },
];

const NODE_COLUMNS: ColumnDef[] = [
  { id: "name", label: "Name", defaultWidth: 220, defaultVisible: true },
  { id: "node_cpu", label: "CPU", defaultWidth: 96, defaultVisible: true },
  { id: "node_memory", label: "Memory", defaultWidth: 106, defaultVisible: true },
  { id: "node_disk", label: "Disk", defaultWidth: 68, defaultVisible: true },
  { id: "node_roles", label: "Roles", defaultWidth: 95, defaultVisible: true },
  { id: "node_taints", label: "Taints", defaultWidth: 65, defaultVisible: true },
  { id: "node_version", label: "Version", defaultWidth: 88, defaultVisible: true },
  { id: "node_ip", label: "Internal IP", defaultWidth: 118, defaultVisible: true },
  { id: "age", label: "Age", defaultWidth: 74, defaultVisible: true },
  { id: "node_schedulable", label: "Schedulable", defaultWidth: 92, defaultVisible: true },
  { id: "node_conditions", label: "Conditions", defaultWidth: 115, defaultVisible: true },
  { id: "node_instance", label: "Instance Type", defaultWidth: 140, defaultVisible: false },
  { id: "node_group", label: "Node Group", defaultWidth: 110, defaultVisible: false },
  { id: "node_kernel", label: "Kernel Version", defaultWidth: 150, defaultVisible: false },
];

const DEPLOYMENT_COLUMNS: ColumnDef[] = [
  { id: "name", label: "Name", defaultWidth: 230, defaultVisible: true },
  { id: "namespace", label: "Namespace", defaultWidth: 125, defaultVisible: true },
  { id: "ready", label: "Replicas", defaultWidth: 90, defaultVisible: false },
  { id: "wl_ready", label: "Ready", defaultWidth: 75, defaultVisible: true },
  { id: "wl_desired", label: "Desired", defaultWidth: 80, defaultVisible: true },
  { id: "wl_updated", label: "Updated", defaultWidth: 80, defaultVisible: true },
  { id: "wl_available", label: "Available", defaultWidth: 85, defaultVisible: true },
  { id: "age", label: "Age", defaultWidth: 85, defaultVisible: true },
  { id: "wl_conditions", label: "Conditions", defaultWidth: 160, defaultVisible: true },
];

const DAEMONSET_COLUMNS: ColumnDef[] = [
  { id: "name", label: "Name", defaultWidth: 230, defaultVisible: true },
  { id: "namespace", label: "Namespace", defaultWidth: 125, defaultVisible: true },
  { id: "wl_desired", label: "Desired", defaultWidth: 80, defaultVisible: true },
  { id: "wl_ready", label: "Current", defaultWidth: 80, defaultVisible: true },
  { id: "wl_ready_cnt", label: "Ready", defaultWidth: 75, defaultVisible: true },
  { id: "wl_updated", label: "Updated", defaultWidth: 80, defaultVisible: true },
  { id: "wl_available", label: "Available", defaultWidth: 85, defaultVisible: true },
  { id: "age", label: "Age", defaultWidth: 85, defaultVisible: true },
];

const STATEFULSET_COLUMNS: ColumnDef[] = [
  { id: "name", label: "Name", defaultWidth: 230, defaultVisible: true },
  { id: "namespace", label: "Namespace", defaultWidth: 125, defaultVisible: true },
  { id: "ready", label: "Pods", defaultWidth: 85, defaultVisible: true },
  { id: "wl_ready", label: "Ready", defaultWidth: 80, defaultVisible: true },
  { id: "wl_desired", label: "Desired", defaultWidth: 80, defaultVisible: true },
  { id: "age", label: "Age", defaultWidth: 85, defaultVisible: true },
];

const REPLICASET_COLUMNS: ColumnDef[] = [
  { id: "name", label: "Name", defaultWidth: 240, defaultVisible: true },
  { id: "namespace", label: "Namespace", defaultWidth: 125, defaultVisible: true },
  { id: "wl_desired", label: "Desired", defaultWidth: 80, defaultVisible: true },
  { id: "wl_ready", label: "Current", defaultWidth: 80, defaultVisible: true },
  { id: "wl_ready_cnt", label: "Ready", defaultWidth: 80, defaultVisible: true },
  { id: "age", label: "Age", defaultWidth: 85, defaultVisible: true },
];

const JOB_COLUMNS: ColumnDef[] = [
  { id: "name", label: "Name", defaultWidth: 240, defaultVisible: true },
  { id: "namespace", label: "Namespace", defaultWidth: 125, defaultVisible: true },
  { id: "ready", label: "Completions", defaultWidth: 110, defaultVisible: true },
  { id: "age", label: "Age", defaultWidth: 85, defaultVisible: true },
  { id: "status", label: "Conditions", defaultWidth: 120, defaultVisible: true },
];

const CRONJOB_COLUMNS: ColumnDef[] = [
  { id: "name", label: "Name", defaultWidth: 230, defaultVisible: true },
  { id: "namespace", label: "Namespace", defaultWidth: 125, defaultVisible: true },
  { id: "ready", label: "Schedule", defaultWidth: 130, defaultVisible: true },
  { id: "cj_suspend", label: "Suspend", defaultWidth: 85, defaultVisible: true },
  { id: "restarts", label: "Active", defaultWidth: 75, defaultVisible: true },
  { id: "age", label: "Age", defaultWidth: 85, defaultVisible: true },
];

const SERVICE_COLUMNS: ColumnDef[] = [
  { id: "name", label: "Name", defaultWidth: 220, defaultVisible: true },
  { id: "namespace", label: "Namespace", defaultWidth: 125, defaultVisible: true },
  { id: "svc_type", label: "Type", defaultWidth: 105, defaultVisible: true },
  { id: "ip", label: "Cluster IP", defaultWidth: 125, defaultVisible: true },
  { id: "ready", label: "Ports", defaultWidth: 160, defaultVisible: true },
  { id: "age", label: "Age", defaultWidth: 85, defaultVisible: true },
  { id: "svc_status", label: "Status", defaultWidth: 95, defaultVisible: true },
];

const CONFIGMAP_COLUMNS: ColumnDef[] = [
  { id: "name", label: "Name", defaultWidth: 250, defaultVisible: true },
  { id: "namespace", label: "Namespace", defaultWidth: 130, defaultVisible: true },
  { id: "cm_keys", label: "Keys", defaultWidth: 280, defaultVisible: true },
  { id: "age", label: "Age", defaultWidth: 90, defaultVisible: true },
];

const SECRET_COLUMNS: ColumnDef[] = [
  { id: "name", label: "Name", defaultWidth: 240, defaultVisible: true },
  { id: "namespace", label: "Namespace", defaultWidth: 130, defaultVisible: true },
  { id: "cm_keys", label: "Keys", defaultWidth: 180, defaultVisible: true },
  { id: "svc_type", label: "Type", defaultWidth: 180, defaultVisible: true },
  { id: "age", label: "Age", defaultWidth: 90, defaultVisible: true },
];

const PVC_COLUMNS: ColumnDef[] = [
  { id: "name", label: "Name", defaultWidth: 230, defaultVisible: true },
  { id: "namespace", label: "Namespace", defaultWidth: 125, defaultVisible: true },
  { id: "node", label: "Storage class", defaultWidth: 150, defaultVisible: true },
  { id: "ready", label: "Size", defaultWidth: 95, defaultVisible: true },
  { id: "age", label: "Age", defaultWidth: 85, defaultVisible: true },
  { id: "status", label: "Status", defaultWidth: 105, defaultVisible: true },
];

const PV_COLUMNS: ColumnDef[] = [
  { id: "name", label: "Name", defaultWidth: 240, defaultVisible: true },
  { id: "node", label: "Storage Class", defaultWidth: 150, defaultVisible: true },
  { id: "ready", label: "Capacity", defaultWidth: 100, defaultVisible: true },
  { id: "age", label: "Age", defaultWidth: 85, defaultVisible: true },
  { id: "status", label: "Status", defaultWidth: 110, defaultVisible: true },
];

const NAMESPACE_COLUMNS: ColumnDef[] = [
  { id: "name", label: "Name", defaultWidth: 240, defaultVisible: true },
  { id: "ns_labels", label: "Labels", defaultWidth: 280, defaultVisible: true },
  { id: "age", label: "Age", defaultWidth: 90, defaultVisible: true },
  { id: "status", label: "Status", defaultWidth: 110, defaultVisible: true },
];

const CRD_COLUMNS: ColumnDef[] = [
  { id: "crd_resource", label: "Resource", defaultWidth: 220, defaultVisible: true },
  { id: "detail", label: "Group", defaultWidth: 210, defaultVisible: true },
  { id: "ready", label: "Version", defaultWidth: 100, defaultVisible: true },
  { id: "svc_type", label: "Scope", defaultWidth: 110, defaultVisible: true },
  { id: "age", label: "Age", defaultWidth: 90, defaultVisible: true },
];

const CR_INSTANCE_COLUMNS: ColumnDef[] = [
  { id: "name", label: "Name", defaultWidth: 280, defaultVisible: true },
  { id: "namespace", label: "Namespace", defaultWidth: 150, defaultVisible: true },
  { id: "age", label: "Age", defaultWidth: 100, defaultVisible: true },
];

const CLUSTER_CATALOG_COLUMNS: ColumnDef[] = [
  { id: "name", label: "Name", defaultWidth: 240, defaultVisible: true },
  { id: "source", label: "Source", defaultWidth: 90, defaultVisible: true },
  { id: "labels", label: "Labels", defaultWidth: 220, defaultVisible: true },
  { id: "distro", label: "Distro", defaultWidth: 90, defaultVisible: true },
  { id: "version", label: "Version", defaultWidth: 100, defaultVisible: true },
  { id: "nodes", label: "Nodes", defaultWidth: 80, defaultVisible: true },
  { id: "status", label: "Status", defaultWidth: 110, defaultVisible: true },
];

const STORAGE_CLASS_COLUMNS: ColumnDef[] = [
  { id: "name", label: "Name", defaultWidth: 230, defaultVisible: true },
  { id: "ready", label: "Provisioner", defaultWidth: 220, defaultVisible: true },
  { id: "svc_type", label: "Reclaim Policy", defaultWidth: 130, defaultVisible: true },
  { id: "detail", label: "Volume Binding Mode", defaultWidth: 170, defaultVisible: true },
  { id: "age", label: "Age", defaultWidth: 90, defaultVisible: true },
];

const GENERIC_RESOURCE_COLUMNS: ColumnDef[] = [
  { id: "name", label: "Name", defaultWidth: 250, defaultVisible: true },
  { id: "namespace", label: "Namespace", defaultWidth: 130, defaultVisible: true },
  { id: "ready", label: "Info", defaultWidth: 140, defaultVisible: true },
  { id: "detail", label: "Details", defaultWidth: 240, defaultVisible: true },
  { id: "age", label: "Age", defaultWidth: 90, defaultVisible: true },
  { id: "status", label: "Status", defaultWidth: 115, defaultVisible: true },
];

function columnsForKind(kind: string): ColumnDef[] {
  if (kind.startsWith("CR:")) return CR_INSTANCE_COLUMNS;
  switch (kind) {
    case "Pod":
      return POD_COLUMNS;
    case "Node":
      return NODE_COLUMNS;
    case "Deployment":
      return DEPLOYMENT_COLUMNS;
    case "DaemonSet":
      return DAEMONSET_COLUMNS;
    case "StatefulSet":
      return STATEFULSET_COLUMNS;
    case "ReplicaSet":
    case "ReplicationController":
      return REPLICASET_COLUMNS;
    case "Job":
      return JOB_COLUMNS;
    case "CronJob":
      return CRONJOB_COLUMNS;
    case "Service":
      return SERVICE_COLUMNS;
    case "ConfigMap":
      return CONFIGMAP_COLUMNS;
    case "Secret":
      return SECRET_COLUMNS;
    case "PersistentVolumeClaim":
      return PVC_COLUMNS;
    case "PersistentVolume":
      return PV_COLUMNS;
    case "StorageClass":
      return STORAGE_CLASS_COLUMNS;
    case "Namespace":
      return NAMESPACE_COLUMNS;
    case "CustomResourceDefinition":
      return CRD_COLUMNS;
    case "ClusterCatalog":
      return CLUSTER_CATALOG_COLUMNS;
    default:
      return GENERIC_RESOURCE_COLUMNS;
  }
}

function statusClass(status: string): "ok" | "warn" | "err" {
  const low = String(status || "").toLowerCase();
  if (
    low.includes("err") ||
    low.includes("fail") ||
    low.includes("crash") ||
    low.includes("notready") ||
    low.includes("backoff") ||
    low.includes("oom")
  ) {
    return "err";
  }
  if (
    low.includes("pend") ||
    low.includes("prog") ||
    low.includes("scal") ||
    low.includes("warn") ||
    low.includes("terminat") ||
    low.includes("creating")
  ) {
    return "warn";
  }
  return "ok";
}

function sendToBackend(payload: Record<string, unknown>) {
  if (typeof window !== "undefined" && window.openidea) {
    window.openidea.postMessage(JSON.stringify(payload));
  }
}

const LOG_TOKEN_RE =
  /(\d{4}[-/]\d\d[-/]\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:[.,]\d+)?)?(?:Z|[+-]\d\d(?::?\d\d)?)?)?|\b\d\d:\d\d:\d\d(?:[.,]\d+)?\b)|(\b[IWEF]\d{4}\b|\b(?:FATAL|CRITICAL|SEVERE|ERROR|ERR|WARNING|WARN|INFO|DEBUG|TRACE)\b)|(\b[\w./-]+\.(?:go|rs|py|java|kt|ts|tsx|js|c|cc|cpp|h):\d+\b)|(\b[a-zA-Z_][\w.-]*=)|("(?:[^"\\]|\\.)*")|(\b(?:true|false|null)\b)/g;

function highlightSegment(text: string, keyPrefix: string): React.ReactNode[] {
  if (!text) return [];
  const nodes: React.ReactNode[] = [];
  let last = 0;
  LOG_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LOG_TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(text.slice(last, m.index));
    }
    const full = m[0];
    let cls = "";
    if (m[1]) cls = "fl-tok-time";
    else if (m[2]) {
      const u = full.toUpperCase();
      if (u.startsWith("E") || u.startsWith("F") || u === "CRITICAL" || u === "SEVERE") cls = "fl-tok-err";
      else if (u.startsWith("W")) cls = "fl-tok-warn";
      else cls = "fl-tok-info";
    } else if (m[3]) cls = "fl-tok-loc";
    else if (m[4]) cls = "fl-tok-key";
    else if (m[5]) cls = "fl-tok-str";
    else if (m[6]) cls = "fl-tok-kw";
    nodes.push(
      <span key={`${keyPrefix}-${m.index}`} className={cls}>
        {full}
      </span>,
    );
    last = m.index + full.length;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes;
}

function DrawerLogViewer({ text }: { text: string }) {
  const [findOpen, setFindOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);
  const [activeLineIdx, setActiveLineIdx] = useState<number | null>(null);
  const [fontZoom, setFontZoom] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);

  const lines = useMemo(() => (text || "").split("\n"), [text]);

  const searchRegex = useMemo(() => {
    if (!query) return null;
    try {
      const escaped = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = wholeWord ? `\\b(?:${escaped})\\b` : escaped;
      return new RegExp(pattern, matchCase ? "g" : "gi");
    } catch {
      return null;
    }
  }, [query, matchCase, wholeWord, useRegex]);

  const matches = useMemo(() => {
    const list: { line: number; start: number; end: number }[] = [];
    if (!searchRegex) return list;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      searchRegex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = searchRegex.exec(l)) !== null) {
        if (m[0].length === 0) {
          searchRegex.lastIndex++;
          continue;
        }
        list.push({ line: i, start: m.index, end: m.index + m[0].length });
        if (list.length >= 2000) return list;
      }
    }
    return list;
  }, [lines, searchRegex]);

  const curIdx = matches.length > 0 ? ((activeMatchIdx % matches.length) + matches.length) % matches.length : 0;

  useEffect(() => {
    const active = matches[curIdx];
    if (!active || !viewerRef.current) return;
    const row = viewerRef.current.querySelector(`[data-log-line="${active.line}"]`);
    row?.scrollIntoView({ block: "center" });
  }, [curIdx, matches]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "f") {
      e.preventDefault();
      e.stopPropagation();
      setFindOpen(true);
      requestAnimationFrame(() => {
        findInputRef.current?.focus();
        findInputRef.current?.select();
      });
    } else if (mod && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      e.stopPropagation();
      setFontZoom((z) => Math.min(24, z + 1));
    } else if (mod && (e.key === "-" || e.key === "_")) {
      e.preventDefault();
      e.stopPropagation();
      setFontZoom((z) => Math.max(-5, z - 1));
    } else if (mod && e.key === "0") {
      e.preventDefault();
      e.stopPropagation();
      setFontZoom(0);
    } else if (e.key === "Escape" && findOpen) {
      e.preventDefault();
      e.stopPropagation();
      setFindOpen(false);
      viewerRef.current?.focus();
    }
  };

  let globalMatchCounter = 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }} onKeyDown={onKeyDown}>
      {findOpen && (
        <div className="fl-log-findbar">
          <div className="fl-log-find-box">
            <span style={{ color: "var(--fl-fg-muted)", fontSize: 12 }}>🔍</span>
            <input
              ref={findInputRef}
              className="fl-log-find-input"
              placeholder="Find"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveMatchIdx(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setActiveMatchIdx((i) => i + (e.shiftKey ? -1 : 1));
                }
              }}
            />
            <button
              className={`fl-log-find-toggle ${matchCase ? "active" : ""}`}
              title="Match Case"
              onClick={() => setMatchCase((v) => !v)}
            >
              Cc
            </button>
            <button
              className={`fl-log-find-toggle ${wholeWord ? "active" : ""}`}
              title="Words"
              onClick={() => setWholeWord((v) => !v)}
            >
              W
            </button>
            <button
              className={`fl-log-find-toggle ${useRegex ? "active" : ""}`}
              title="Regex"
              onClick={() => setUseRegex((v) => !v)}
            >
              .*
            </button>
          </div>
          <span style={{ fontSize: 11.5, color: "var(--fl-fg-muted)", minWidth: 64 }}>
            {query ? (matches.length > 0 ? `${curIdx + 1}/${matches.length}` : "0 results") : ""}
          </span>
          <button
            className="fl-icon-btn"
            style={{ width: 24, height: 24, padding: 0 }}
            title="Previous Occurrence (⇧↵)"
            disabled={matches.length === 0}
            onClick={() => setActiveMatchIdx((i) => i - 1)}
          >
            ↑
          </button>
          <button
            className="fl-icon-btn"
            style={{ width: 24, height: 24, padding: 0 }}
            title="Next Occurrence (↵)"
            disabled={matches.length === 0}
            onClick={() => setActiveMatchIdx((i) => i + 1)}
          >
            ↓
          </button>
        </div>
      )}
      <div
        ref={viewerRef}
        className="fl-log-viewer"
        tabIndex={0}
        style={{
          fontSize: `calc(var(--openidea-font-code-size, 12px) + ${fontZoom}px)`,
          lineHeight: `calc(var(--openidea-font-code-line-height, 18px) + ${Math.round(fontZoom * 1.5)}px)`,
        }}
      >
        {lines.map((line, lineIdx) => {
          const lineMatches = matches.filter((m) => m.line === lineIdx);
          let content: React.ReactNode;
          if (lineMatches.length === 0) {
            content = highlightSegment(line, `l${lineIdx}`);
          } else {
            const parts: React.ReactNode[] = [];
            let pos = 0;
            lineMatches.forEach((m, mi) => {
              const mIdx = globalMatchCounter++;
              if (m.start > pos) {
                parts.push(...highlightSegment(line.slice(pos, m.start), `l${lineIdx}-p${mi}`));
              }
              parts.push(
                <mark key={`m-${lineIdx}-${mi}`} className={`fl-log-match ${mIdx === curIdx ? "current" : ""}`}>
                  {line.slice(m.start, m.end)}
                </mark>,
              );
              pos = m.end;
            });
            if (pos < line.length) {
              parts.push(...highlightSegment(line.slice(pos), `l${lineIdx}-end`));
            }
            content = parts;
          }
          return (
            <div
              key={lineIdx}
              data-log-line={lineIdx}
              className={`fl-log-line ${activeLineIdx === lineIdx ? "active" : ""}`}
              onClick={() => setActiveLineIdx(lineIdx)}
            >
              <span className="fl-log-ln">{lineIdx + 1}</span>
              <span className="fl-log-content">{content || " "}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<ClusterSnapshot>({
    connected: false,
    error: null,
    current_context: "",
    contexts: [],
    cluster_catalog: [],
    current_namespace: "default",
    all_namespaces: false,
    namespaces: ["default"],
    resources: [],
    events: [],
    helm_releases: [],
  });
  const [workspace, setWorkspace] = useState<WorkspaceManifest[]>([]);
  const [activeKind, setActiveKind] = useState<string>("Pod");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    favorites: true,
    workloads: true,
    storage: true,
    catalog: false,
  });
  const [sidebarWidth, setSidebarWidth] = useState<number>(210);
  const [clusterMenuOpen, setClusterMenuOpen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [banner, setBanner] = useState<{ text: string; isError: boolean } | null>(null);
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  const [checkedRows, setCheckedRows] = useState<Record<string, boolean>>({});
  const [sortCol, setSortCol] = useState<string>("name");
  const [sortAsc, setSortAsc] = useState<boolean>(true);
  const [colMenuOpen, setColMenuOpen] = useState<boolean>(false);

  // Column visibility, order, and widths per kind
  const [colOrderByKind, setColOrderByKind] = useState<Record<string, string[]>>({});
  const [colVisByKind, setColVisByKind] = useState<Record<string, Record<string, boolean>>>({});
  const [colWidthsByKind, setColWidthsByKind] = useState<Record<string, Record<string, number>>>({});

  // Slide-over Right Detail Drawer state
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const [drawerWidth, setDrawerWidth] = useState<number>(560);
  const [drawerMode, setDrawerMode] = useState<"overview" | "yaml" | "logs" | "describe" | "shell">("overview");
  const [drawerJson, setDrawerJson] = useState<Record<string, any> | null>(null);
  const [drawerExtraPods, setDrawerExtraPods] = useState<ClusterResource[]>([]);
  const [drawerExtraResources, setDrawerExtraResources] = useState<ClusterResource[]>([]);
  const [drawerExtraEvents, setDrawerExtraEvents] = useState<ClusterEvent[]>([]);
  const [selectedResourceFallback, setSelectedResourceFallback] = useState<ClusterResource | null>(null);
  const [drawerRawText, setDrawerRawText] = useState<string>("");
  const [yamlDraft, setYamlDraft] = useState<string>("");
  const [activeMetricTab, setActiveMetricTab] = useState<"CPU" | "Memory" | "Network" | "Filesystem">("CPU");
  const [logContainer, setLogContainer] = useState<string>("");
  const [logPrevious, setLogPrevious] = useState<boolean>(false);
  const [logContainerMenuOpen, setLogContainerMenuOpen] = useState<boolean>(false);
  const [shellContainerMenuOpen, setShellContainerMenuOpen] = useState<boolean>(false);

  // Searchable Namespace Picker state
  const [nsMenuOpen, setNsMenuOpen] = useState<boolean>(false);
  const [nsSearch, setNsSearch] = useState<string>("");

  const loadedLazyRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    if (typeof window === "undefined" || !window.openidea) return;
    window.openidea.onMessage((raw: string) => {
      try {
        const m = JSON.parse(raw);
        if (m.op === "pty-data" || m.op === "pty-exit") {
          dispatchPtyEvent(m);
          return;
        }
        if (m.op === "state") {
          setSnapshot((prev) => {
            const next: ClusterSnapshot = m.snapshot || prev;
            if ((!next.cluster_catalog || next.cluster_catalog.length === 0) && prev.cluster_catalog.length > 0) {
              next.cluster_catalog = prev.cluster_catalog;
            }
            if ((!next.contexts || next.contexts.length === 0) && prev.contexts.length > 0) {
              next.contexts = prev.contexts;
            }
            if (
              next.current_context === prev.current_context &&
              (!next.namespaces || next.namespaces.length <= 3) &&
              prev.namespaces.length > 3
            ) {
              next.namespaces = prev.namespaces;
            }
            return { ...next };
          });
          if (Array.isArray(m.workspace)) {
            setWorkspace(m.workspace);
          }
          if (m.snapshot?.error) {
            setBanner({ text: m.snapshot.error, isError: true });
          } else {
            setBanner(null);
          }
          if (m.needsBackgroundSync) {
            const curCtx = m.snapshot?.current_context || "";
            sendToBackend({ op: "sync-cluster", context: curCtx });
          } else if (m.needsClusterFetch) {
            sendToBackend({ op: "load-category", category: "Pod" });
          }
        } else if (m.op === "resource-json") {
          try {
            setDrawerJson(JSON.parse(m.json));
          } catch {
            setDrawerJson(null);
          }
        } else if (m.op === "resource-extras") {
          setDrawerExtraPods(Array.isArray(m.relatedPods) ? m.relatedPods : []);
          setDrawerExtraResources(Array.isArray(m.relatedResources) ? m.relatedResources : []);
          setDrawerExtraEvents(Array.isArray(m.events) ? m.events : []);
        } else if (m.op === "detail") {
          const text = m.text || "";
          setDrawerRawText(text);
          setYamlDraft(text);
          if (m.banner) {
            setBanner({ text: m.banner, isError: Boolean(m.error) });
          }
        }
      } catch {
        // ignore malformed message
      }
    });
    sendToBackend({ op: "init" });
  }, []);

  const catalogList: ClusterContextInfo[] = useMemo(() => {
    if (snapshot.cluster_catalog && snapshot.cluster_catalog.length > 0) {
      return snapshot.cluster_catalog;
    }
    return (snapshot.contexts || []).map((name) => ({
      name,
      cluster: name,
      server: "",
      user: "",
      namespace: "default",
      source: "~/.kube/config",
      short_name: shortBadge(name),
      version: "",
      distro: "",
      nodes: null,
      last_seen: "",
      hotbar_pinned: false,
      hotbar_order: null,
    }));
  }, [snapshot.cluster_catalog, snapshot.contexts]);

  const hotbarItems: ClusterContextInfo[] = useMemo(() => {
    const pinned = catalogList
      .filter((c) => c.hotbar_pinned)
      .slice()
      .sort((a, b) => (a.hotbar_order ?? 999) - (b.hotbar_order ?? 999));
    return pinned.length > 0 ? pinned : catalogList.slice(0, 6);
  }, [catalogList]);

  const activeClusterInfo = useMemo(() => {
    return (
      catalogList.find((c) => c.name === snapshot.current_context) || {
        name: snapshot.current_context || "default",
        short_name: shortBadge(snapshot.current_context || "K8S"),
      }
    );
  }, [catalogList, snapshot.current_context]);

  function handleSwitchContext(chosen: string, targetKind?: string) {
    const entry = catalogList.find((c) => c.name === chosen);
    const defaultNs = (entry && entry.namespace) || "default";
    const nextKind = targetKind || (activeKind === "ClusterCatalog" ? "Pod" : activeKind);
    loadedLazyRef.current = {};
    setClusterMenuOpen(false);
    setSelectedRowKey(null);
    setDrawerOpen(false);
    setDrawerJson(null);
    setActiveKind(nextKind);
    setSnapshot((prev) => ({
      ...prev,
      current_context: chosen,
      current_namespace: defaultNs,
      all_namespaces: false,
      error: null,
      resources: [],
      events: [],
      helm_releases: [],
      namespaces: Array.from(new Set([defaultNs, "default", "kube-system"])),
    }));
    setBanner({ text: `Connecting to ${chosen} (${defaultNs})…`, isError: false });
    sendToBackend({ op: "set-context", context: chosen, category: nextKind });
  }

  function handleSelectKind(nextKind: string) {
    setActiveKind(nextKind);
    setSelectedRowKey(null);
    setDrawerOpen(false);
    setColMenuOpen(false);
    // Ensure parent group is expanded
    const parentGroup = SIDEBAR_TREE.find((g) => g.items?.some((i) => i.kind === nextKind));
    if (parentGroup) {
      setExpandedGroups((prev) => ({ ...prev, [parentGroup.id]: true }));
    }
    if (nextKind !== "ClusterCatalog") {
      const hasAny = (snapshot.resources || []).some((r) => r.kind === nextKind);
      if (!hasAny && nextKind !== "Workspace" && nextKind !== "ClusterOverview" && nextKind !== "WorkloadsOverview") {
        setBanner({ text: `Loading ${nextKind}…`, isError: false });
      }
      loadedLazyRef.current[nextKind] = true;
      sendToBackend({ op: "load-category", category: nextKind });
    }
  }

  function handleSelectNamespace(val: string) {
    loadedLazyRef.current = {};
    setSelectedRowKey(null);
    setDrawerOpen(false);
    if (val === "__ALL__") {
      setSnapshot((prev) => ({ ...prev, all_namespaces: true }));
      setBanner({ text: "Querying all namespaces…", isError: false });
      sendToBackend({ op: "set-all-namespaces", all: true, category: activeKind });
    } else {
      setSnapshot((prev) => ({ ...prev, current_namespace: val, all_namespaces: false }));
      setBanner({ text: `Switching namespace to ${val}…`, isError: false });
      sendToBackend({ op: "set-namespace", namespace: val, category: activeKind });
    }
  }

  // Active columns configuration for the current kind
  const baseCols = useMemo(() => columnsForKind(activeKind), [activeKind]);
  const orderedCols = useMemo(() => {
    const customOrder = colOrderByKind[activeKind];
    if (!customOrder) return baseCols;
    const map = new Map(baseCols.map((c) => [c.id, c]));
    const result: ColumnDef[] = [];
    for (const id of customOrder) {
      const c = map.get(id);
      if (c) {
        result.push(c);
        map.delete(id);
      }
    }
    for (const c of map.values()) result.push(c);
    return result;
  }, [baseCols, colOrderByKind, activeKind]);

  const visibleCols = useMemo(() => {
    const visMap = colVisByKind[activeKind] || {};
    return orderedCols.filter((c) => (visMap[c.id] !== undefined ? visMap[c.id] : c.defaultVisible));
  }, [orderedCols, colVisByKind, activeKind]);

  function getColWidth(col: ColumnDef): number {
    return colWidthsByKind[activeKind]?.[col.id] ?? col.defaultWidth;
  }

  function toggleColVisible(colId: string) {
    setColVisByKind((prev) => {
      const cur = prev[activeKind] || {};
      const def = baseCols.find((c) => c.id === colId)?.defaultVisible ?? true;
      const isVis = cur[colId] !== undefined ? cur[colId] : def;
      return {
        ...prev,
        [activeKind]: { ...cur, [colId]: !isVis },
      };
    });
  }

  function moveColumn(colId: string, dir: -1 | 1) {
    const ids = orderedCols.map((c) => c.id);
    const idx = ids.indexOf(colId);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= ids.length) return;
    const next = ids.slice();
    const [removed] = next.splice(idx, 1);
    next.splice(target, 0, removed);
    setColOrderByKind((prev) => ({ ...prev, [activeKind]: next }));
  }

  function startColResize(e: React.MouseEvent, col: ColumnDef) {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startW = getColWidth(col);
    const onMove = (ev: MouseEvent) => {
      const nextW = Math.max(36, startW + (ev.clientX - startX));
      setColWidthsByKind((prev) => ({
        ...prev,
        [activeKind]: { ...(prev[activeKind] || {}), [col.id]: nextW },
      }));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function startSidebarResize(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      setSidebarWidth(Math.min(360, Math.max(150, startW + (ev.clientX - startX))));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function startDrawerResize(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = drawerWidth;
    const onMove = (ev: MouseEvent) => {
      setDrawerWidth(Math.min(920, Math.max(340, startW - (ev.clientX - startX))));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // Filtered and sorted rows for the active view
  const filteredResources = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = (snapshot.resources || []).filter(
      (r) =>
        r.kind === activeKind &&
        (!q ||
          r.name.toLowerCase().includes(q) ||
          (r.namespace || "").toLowerCase().includes(q) ||
          (r.status || "").toLowerCase().includes(q) ||
          (r.controlled_by_kind || "").toLowerCase().includes(q)),
    );
    return list.slice().sort((a, b) => {
      if (sortCol === "cpu" || sortCol === "node_cpu") {
        const av = cpuUnitsToNumber((a.cpu || "").split("/")[0]);
        const bv = cpuUnitsToNumber((b.cpu || "").split("/")[0]);
        return sortAsc ? av - bv : bv - av;
      }
      if (sortCol === "memory" || sortCol === "node_memory") {
        const av = unitsToBytes((a.memory || "").split("/")[0]);
        const bv = unitsToBytes((b.memory || "").split("/")[0]);
        return sortAsc ? av - bv : bv - av;
      }
      if (sortCol === "restarts" || sortCol === "node_taints") {
        const av = a.restarts ?? 0;
        const bv = b.restarts ?? 0;
        return sortAsc ? av - bv : bv - av;
      }
      const av = String((a as any)[sortCol] ?? a.name ?? "");
      const bv = String((b as any)[sortCol] ?? b.name ?? "");
      return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
    });
  }, [snapshot.resources, activeKind, searchQuery, sortCol, sortAsc]);

  const selectedResource: ClusterResource | null = useMemo(() => {
    if (!selectedRowKey) return null;
    const matchFn = (r: ClusterResource) => `${r.kind}:${r.namespace}/${r.name}` === selectedRowKey;
    return (
      (snapshot.resources || []).find(matchFn) ||
      drawerExtraPods.find(matchFn) ||
      drawerExtraResources.find(matchFn) ||
      (selectedResourceFallback && matchFn(selectedResourceFallback) ? selectedResourceFallback : null)
    );
  }, [snapshot.resources, drawerExtraPods, drawerExtraResources, selectedResourceFallback, selectedRowKey]);

  const allAvailableNamespaces = useMemo(() => {
    const set = new Set<string>(snapshot.namespaces || []);
    if (snapshot.current_namespace) set.add(snapshot.current_namespace);
    for (const r of snapshot.resources || []) {
      if (r.kind === "Namespace" && r.name) set.add(r.name);
      else if (r.namespace) set.add(r.namespace);
    }
    return Array.from(set).filter(Boolean).sort();
  }, [snapshot.namespaces, snapshot.current_namespace, snapshot.resources]);

  function getPodContainerItems(
    res: ClusterResource,
    json: Record<string, any> | null,
  ): Array<{ name: string; cls: string }> {
    const items: Array<{ name: string; cls: string }> = [];
    const seen = new Set<string>();
    const clsFor = (state: string, ready: boolean, reason: string): string => {
      if (state === "terminated") {
        return reason === "Completed" || res.status === "Succeeded" ? "completed" : "failed";
      }
      if (state === "waiting" || !ready) return "waiting";
      return "running";
    };

    for (const cs of res.container_states || []) {
      if (cs.name && !seen.has(cs.name)) {
        seen.add(cs.name);
        items.push({ name: cs.name, cls: clsFor(cs.state, cs.ready, cs.reason) });
      }
    }
    const statusMap = new Map<string, any>();
    for (const cs of json?.status?.containerStatuses || []) {
      if (cs?.name) statusMap.set(cs.name, cs);
    }
    for (const cname of res.containers || []) {
      if (cname && !seen.has(cname)) {
        seen.add(cname);
        const st = statusMap.get(cname);
        const running = Boolean(st?.state?.running);
        const ready = st?.ready !== undefined ? Boolean(st.ready) : res.status === "Running";
        items.push({ name: cname, cls: running || ready ? "running" : "waiting" });
      }
    }
    for (const c of json?.spec?.containers || []) {
      if (c?.name && !seen.has(c.name)) {
        seen.add(c.name);
        const st = statusMap.get(c.name);
        const running = Boolean(st?.state?.running);
        const ready = st?.ready !== undefined ? Boolean(st.ready) : res.status === "Running";
        items.push({ name: c.name, cls: running || ready ? "running" : "waiting" });
      }
    }
    return items;
  }

  function openPodLogsInEditorTab(res: ClusterResource, containerName: string) {
    const ns = res.namespace || snapshot.current_namespace || "default";
    const ctx = snapshot.current_context;
    const baseArgs: string[] = [];
    if (ctx) baseArgs.push(`--context=${ctx}`);
    if (ns) baseArgs.push("-n", ns);
    baseArgs.push("logs", "-f", "--tail=500", res.name);
    if (containerName) baseArgs.push("-c", containerName);
    const title = containerName ? `Logs: ${res.name} (${containerName})` : `Logs: ${res.name}`;
    const key = `pluginLog:openidea.kubernetes:${ctx}:${ns}:${res.name}:${containerName}`;
    sendToBackend({
      op: "open-log-tab",
      key,
      title,
      program: "kubectl",
      baseArgs,
      toggles: [
        { id: "timestamps", label: "Timestamps", args: ["--timestamps=true"] },
        { id: "previous", label: "Previous", args: ["--previous"] },
      ],
    });
  }

  function openResourceYamlInEditorTab(res: ClusterResource) {
    const ctx = snapshot.current_context;
    const ns = res.namespace || "";
    const displayKind = res.kind.startsWith("CR:") ? res.controlled_by_kind || res.kind.slice(3) : res.kind;
    const title = `${displayKind}: ${res.name}.yaml`;
    const key = `pluginResourceYaml:openidea.kubernetes:${ctx}:${ns}:${res.kind}:${res.name}`;
    sendToBackend({
      op: "open-yaml-tab",
      key,
      title,
      context: ctx,
      namespace: ns,
      kind: res.kind,
      name: res.name,
    });
  }

  function openResourceDrawer(
    res: ClusterResource,
    mode: "overview" | "yaml" | "logs" | "describe" | "shell" = "overview",
  ) {
    if (mode === "yaml") {
      openResourceYamlInEditorTab(res);
      return;
    }
    if (mode === "logs") {
      const firstContainer = (res.containers && res.containers[0]) || "";
      openPodLogsInEditorTab(res, firstContainer);
      return;
    }
    const key = `${res.kind}:${res.namespace}/${res.name}`;
    setSelectedRowKey(key);
    setSelectedResourceFallback(res);
    setDrawerOpen(true);
    setDrawerMode(mode);
    setLogContainerMenuOpen(false);
    setShellContainerMenuOpen(false);
    const firstContainer = (res.containers && res.containers[0]) || "";
    setLogContainer(firstContainer);
    if (mode === "overview") {
      setDrawerJson(null);
      setDrawerExtraPods([]);
      setDrawerExtraResources([]);
      setDrawerExtraEvents([]);
      sendToBackend({
        op: "inspect-json",
        kind: res.kind,
        namespace: res.namespace,
        name: res.name,
      });
    } else if (mode === "describe") {
      setDrawerRawText("Running kubectl describe…");
      sendToBackend({
        op: "inspect",
        kind: res.kind,
        namespace: res.namespace,
        name: res.name,
        yaml: false,
      });
    }
  }

  function openResourceByRef(kind: string, name: string, namespace?: string) {
    const clusterScoped = [
      "Node",
      "Namespace",
      "PersistentVolume",
      "StorageClass",
      "CustomResourceDefinition",
      "ClusterRole",
      "ClusterRoleBinding",
      "IngressClass",
      "PriorityClass",
      "RuntimeClass",
      "MutatingWebhookConfiguration",
      "ValidatingWebhookConfiguration",
    ].includes(kind);
    const ns = clusterScoped ? "" : (namespace ?? snapshot.current_namespace ?? "");
    const existing =
      (snapshot.resources || []).find(
        (r) => r.kind === kind && r.name === name && (clusterScoped || !ns || r.namespace === ns),
      ) ||
      drawerExtraPods.find((r) => r.kind === kind && r.name === name && (!ns || r.namespace === ns)) ||
      drawerExtraResources.find((r) => r.kind === kind && r.name === name && (!ns || r.namespace === ns));
    const target: ClusterResource = existing || {
      kind,
      name,
      namespace: ns,
      status: "Active",
      ready: "",
      age: "",
      detail: "",
      containers: [],
      ports: [],
      data_keys: [],
      container_states: [],
      cpu: "",
      memory: "",
      restarts: 0,
      controlled_by_kind: "",
      controlled_by_name: "",
      pod_ip: "",
      host_ip: "",
      node_name: "",
      qos: "",
      labels: [],
    };
    openResourceDrawer(target, "overview");
  }

  function renderContainerSquares(res: ClusterResource) {
    const states: ContainerStateBadge[] =
      res.container_states && res.container_states.length > 0
        ? res.container_states
        : (res.containers || []).map((name) => ({
            name,
            state: res.status === "Succeeded" || res.status === "Completed" ? "terminated" : "running",
            ready: res.status === "Running",
            reason: res.status,
            is_init: false,
          }));
    return (
      <div className="fl-container-squares">
        {states.map((cs, i) => {
          let cls = "running";
          if (cs.state === "terminated") {
            cls = cs.reason === "Completed" || res.status === "Succeeded" ? "completed" : "failed";
          } else if (cs.state === "waiting") {
            cls = "waiting";
          } else if (!cs.ready) {
            cls = "waiting";
          }
          const tip = `${cs.is_init ? "[init] " : ""}${cs.name}: ${cs.state}${cs.reason ? ` (${cs.reason})` : ""}`;
          return <span key={`${cs.name}-${i}`} className={`fl-csq ${cls}`} title={tip} />;
        })}
      </div>
    );
  }

  function renderPodCell(res: ClusterResource, colId: string) {
    switch (colId) {
      case "name":
        return <span style={{ fontWeight: 500 }}>{res.name}</span>;
      case "warning": {
        const hasWarn = (res.restarts ?? 0) > 0 || statusClass(res.status) !== "ok";
        return hasWarn ? (
          <span style={{ color: "var(--fl-orange)" }} title={`Status: ${res.status}, Restarts: ${res.restarts ?? 0}`}>
            ⚠
          </span>
        ) : null;
      }
      case "namespace":
        return (
          <span
            className="fl-link-teal"
            onClick={(e) => {
              e.stopPropagation();
              if (res.namespace) handleSelectNamespace(res.namespace);
            }}
          >
            {res.namespace || "default"}
          </span>
        );
      case "containers":
        return renderContainerSquares(res);
      case "cpu":
        return <span>{res.cpu || "N/A"}</span>;
      case "memory":
        return <span>{res.memory || "N/A"}</span>;
      case "restarts":
        return <span>{res.restarts ?? 0}</span>;
      case "controlled_by":
        return res.controlled_by_kind ? (
          <span
            className="fl-link-teal"
            title={`${res.controlled_by_kind}/${res.controlled_by_name || ""}`}
            onClick={(e) => {
              e.stopPropagation();
              if (res.controlled_by_kind && res.controlled_by_name) {
                openResourceByRef(res.controlled_by_kind, res.controlled_by_name, res.namespace);
              }
            }}
          >
            {res.controlled_by_kind}
          </span>
        ) : (
          <span style={{ color: "var(--fl-fg-muted)" }}>-</span>
        );
      case "ip":
        return <span>{res.pod_ip || "-"}</span>;
      case "node":
        return (
          <span
            className="fl-link-teal"
            onClick={(e) => {
              e.stopPropagation();
              if (res.node_name) handleSelectKind("Node");
            }}
          >
            {res.node_name || "-"}
          </span>
        );
      case "qos":
        return <span>{res.qos || "-"}</span>;
      case "age":
        return <span>{formatCompactAge(res.age)}</span>;
      case "status": {
        const displayStatus = res.status === "Completed" ? "Succeeded" : res.status;
        return <span className={`fl-status-text ${statusClass(displayStatus)}`}>{displayStatus}</span>;
      }
      case "node_cpu": {
        const [uStr, aStr] = (res.cpu || "").split("/");
        const u = parseFloat(uStr || "");
        const a = parseFloat(aStr || "");
        if (!Number.isFinite(a) || a <= 0) return <span>N/A</span>;
        const pct = Math.min(100, Math.max(0, (u / a) * 100));
        return (
          <div className="fl-node-metric-cell" title={`CPU: ${pct.toFixed(1)}% (${uStr} / ${aStr} cores)`}>
            <div className="fl-line-progress">
              <div
                className="fl-line-progress-fill"
                style={{ width: `${pct > 0 ? Math.max(3, pct) : 0}%`, background: "#4db6ac" }}
              />
            </div>
            <div className="fl-node-metric-text">{`${uStr} / ${aStr}`}</div>
          </div>
        );
      }
      case "node_memory": {
        const [uStr, aStr] = (res.memory || "").split("/");
        const u = parseFloat(uStr || "");
        const a = parseFloat(aStr || "");
        if (!Number.isFinite(a) || a <= 0) return <span>N/A</span>;
        const pct = Math.min(100, Math.max(0, (u / a) * 100));
        return (
          <div className="fl-node-metric-cell" title={`Memory: ${pct.toFixed(1)}% (${uStr} / ${aStr})`}>
            <div className="fl-line-progress">
              <div
                className="fl-line-progress-fill"
                style={{ width: `${pct > 0 ? Math.max(3, pct) : 0}%`, background: "#c94bce" }}
              />
            </div>
            <div className="fl-node-metric-text">{`${uStr} / ${aStr}`}</div>
          </div>
        );
      }
      case "node_disk":
        return <span>N/A</span>;
      case "node_roles":
        return <span>{res.host_ip || ""}</span>;
      case "node_taints":
        return (
          <span title={(res.containers || []).join("\n")}>
            {res.restarts ?? (res.containers ? res.containers.length : 0)}
          </span>
        );
      case "node_version":
        return <span>{res.ready || "-"}</span>;
      case "node_ip":
        return <span>{res.pod_ip || res.detail || "-"}</span>;
      case "node_schedulable": {
        const val = res.qos || (res.status.includes("SchedulingDisabled") ? "False" : "True");
        return <span className={`fl-sched-badge ${val === "False" ? "false" : "true"}`}>{val}</span>;
      }
      case "node_conditions":
        return <span className={`fl-status-text ${statusClass(res.status)}`}>{res.status}</span>;
      case "node_instance":
        return <span>{res.controlled_by_kind || "-"}</span>;
      case "node_group":
        return <span>{res.controlled_by_name || "-"}</span>;
      case "node_kernel":
        return <span>{res.node_name || "-"}</span>;
      case "wl_ready":
      case "wl_ready_cnt":
      case "wl_updated":
      case "wl_available": {
        const [rdy] = (res.ready || "0/0").split("/");
        return <span>{rdy || "0"}</span>;
      }
      case "wl_desired": {
        const parts = (res.ready || "0/0").split("/");
        return <span>{parts[1] ?? parts[0] ?? "0"}</span>;
      }
      case "wl_conditions":
        return (
          <div style={{ display: "flex", gap: 8 }}>
            {res.status === "Ready" ? (
              <>
                <span className="fl-status-text ok">Available</span>
                <span style={{ color: "#1976d2", fontWeight: 500 }}>Progressing</span>
              </>
            ) : (
              <span className={`fl-status-text ${statusClass(res.status)}`}>{res.status}</span>
            )}
          </div>
        );
      case "cj_suspend":
        return <span className="fl-chip">{res.status === "Suspended" ? "True" : "False"}</span>;
      case "svc_type":
        return <span>{res.status}</span>;
      case "svc_status":
        return <span className="fl-status-text ok">Active</span>;
      case "cm_keys":
        return (
          <span>{(res.data_keys && res.data_keys.length > 0 ? res.data_keys.join(", ") : res.detail) || "-"}</span>
        );
      case "ns_labels":
        return (
          <div className="fl-chips">
            {(res.labels || []).slice(0, 3).map((l) => (
              <span key={l} className="fl-chip">
                {l}
              </span>
            ))}
          </div>
        );
      case "ready":
        return <span>{res.ready}</span>;
      case "detail":
        return <span>{res.detail}</span>;
      case "crd_resource": {
        const label = res.controlled_by_kind || res.name;
        return (
          <span
            className="fl-link-teal"
            title={`View ${label} instances (${res.name})`}
            onClick={(e) => {
              e.stopPropagation();
              handleSelectKind(`CR:${res.name}`);
            }}
          >
            {label}
          </span>
        );
      }
      default:
        return null;
    }
  }

  // Group discovered CustomResourceDefinitions by API group (e.g. argoproj.io -> [Application, ApplicationSet, AppProject])
  const crdGroups = useMemo(() => {
    const map = new Map<string, Array<{ crdName: string; kindLabel: string; targetKind: string }>>();
    for (const r of snapshot.resources || []) {
      if (r.kind !== "CustomResourceDefinition") continue;
      const group = r.detail || r.name.split(".").slice(1).join(".") || "custom";
      const kindLabel = r.controlled_by_kind || r.name.split(".")[0] || r.name;
      const list = map.get(group) || [];
      list.push({ crdName: r.name, kindLabel, targetKind: `CR:${r.name}` });
      map.set(group, list);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([group, items]) => ({
        group,
        items: items.sort((a, b) => a.kindLabel.localeCompare(b.kindLabel)),
      }));
  }, [snapshot.resources]);

  // Active group for top horizontal sibling tabs
  const activeGroup = useMemo(() => {
    if (activeKind.startsWith("CR:")) {
      const foundCrdGroup = crdGroups.find((cg) => cg.items.some((i) => i.targetKind === activeKind));
      if (foundCrdGroup) {
        return {
          id: `crd-${foundCrdGroup.group}`,
          label: foundCrdGroup.group,
          items: foundCrdGroup.items.map((i) => ({ kind: i.targetKind, label: i.kindLabel })),
        };
      }
    }
    return SIDEBAR_TREE.find((g) => g.items?.some((i) => i.kind === activeKind)) || null;
  }, [activeKind, crdGroups]);

  const currentViewLabel = useMemo(() => {
    if (activeKind.startsWith("CR:")) {
      for (const cg of crdGroups) {
        const hit = cg.items.find((i) => i.targetKind === activeKind);
        if (hit) return hit.kindLabel;
      }
      return activeKind.slice(3);
    }
    for (const g of SIDEBAR_TREE) {
      if (g.leafKind === activeKind) return g.label;
      const found = g.items?.find((i) => i.kind === activeKind);
      if (found) return found.label;
    }
    return activeKind;
  }, [activeKind, crdGroups]);

  return (
    <div
      className="fl-shell"
      onClick={() => {
        setColMenuOpen(false);
        setClusterMenuOpen(false);
        setNsMenuOpen(false);
      }}
    >
      {/* Far-left Freelens Hotbar rail */}
      <div className="fl-hotbar">
        <div
          className={`fl-hb-item ${activeKind === "ClusterCatalog" ? "active" : ""}`}
          style={{ background: "#00a7a0" }}
          title={`Cluster Catalog (${catalogList.length} clusters)`}
          onClick={() => handleSelectKind("ClusterCatalog")}
        >
          ALL
        </div>
        {hotbarItems.map((c) => {
          const isCur = c.name === snapshot.current_context && activeKind !== "ClusterCatalog";
          return (
            <div
              key={c.name}
              className={`fl-hb-item ${isCur ? "active" : ""}`}
              style={{ background: avatarColor(c.name) }}
              title={`${c.name} (${c.namespace || "default"})`}
              onClick={() => handleSwitchContext(c.name, activeKind === "ClusterCatalog" ? "Pod" : activeKind)}
            >
              {shortBadge(c)}
            </div>
          );
        })}
      </div>

      {/* Left Collapsible Sidebar */}
      <div className="fl-sidebar" style={{ width: sidebarWidth }}>
        {/* Top Cluster Header (Screenshot 2: [FPG] falcon-phx-ga v) */}
        <div
          className="fl-cluster-header"
          onClick={(e) => {
            e.stopPropagation();
            setClusterMenuOpen((v) => !v);
          }}
        >
          <span className="fl-cluster-badge" style={{ background: avatarColor(activeClusterInfo.name) }}>
            {shortBadge(activeClusterInfo)}
          </span>
          <span className="fl-cluster-title" title={activeClusterInfo.name}>
            {activeClusterInfo.name || "Select Cluster"}
          </span>
          <span style={{ fontSize: 11, opacity: 0.7 }}>▾</span>
        </div>

        {clusterMenuOpen && (
          <div className="fl-cluster-dropdown" onClick={(e) => e.stopPropagation()}>
            {catalogList.map((c) => (
              <div
                key={c.name}
                className={`fl-cluster-opt ${c.name === snapshot.current_context ? "active" : ""}`}
                onClick={() => handleSwitchContext(c.name)}
              >
                <span
                  className="fl-cluster-badge"
                  style={{ width: 22, height: 22, fontSize: 9, background: avatarColor(c.name) }}
                >
                  {shortBadge(c)}
                </span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.name}
                </span>
                {c.version && <span style={{ fontSize: 10, color: "var(--fl-fg-muted)" }}>{c.version}</span>}
              </div>
            ))}
          </div>
        )}

        {/* Collapsible Resource Category Tree */}
        <div className="fl-nav-tree">
          {SIDEBAR_TREE.map((group) => {
            const isLeaf = Boolean(group.leafKind);
            const isExpanded = Boolean(expandedGroups[group.id]);
            const containsActive = isLeaf
              ? group.leafKind === activeKind
              : Boolean(group.items?.some((i) => i.kind === activeKind)) ||
                (group.id === "crd" && activeKind.startsWith("CR:"));

            return (
              <div key={group.id}>
                <div
                  className={`fl-tree-group-header ${
                    !isLeaf && containsActive ? "active-group" : isLeaf && containsActive ? "active-leaf" : ""
                  }`}
                  onClick={() => {
                    if (group.leafKind) {
                      handleSelectKind(group.leafKind);
                    } else {
                      const nextExpanded = !expandedGroups[group.id];
                      setExpandedGroups((prev) => ({ ...prev, [group.id]: nextExpanded }));
                      if (
                        group.id === "crd" &&
                        nextExpanded &&
                        !(snapshot.resources || []).some((r) => r.kind === "CustomResourceDefinition")
                      ) {
                        sendToBackend({ op: "load-category", category: "CustomResourceDefinition" });
                      }
                    }
                  }}
                >
                  <span className="fl-tree-icon">
                    <SidebarIcon id={group.id} />
                  </span>
                  <span className="fl-tree-label">{group.label}</span>
                  {!isLeaf && (
                    <span className="fl-tree-chevron">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        {isExpanded ? (
                          <path d="M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z" />
                        ) : (
                          <path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z" />
                        )}
                      </svg>
                    </span>
                  )}
                </div>
                {!isLeaf && isExpanded && group.items && (
                  <div className="fl-tree-children">
                    {group.items.map((item) => {
                      const isItemActive = item.kind === activeKind;
                      return (
                        <div
                          key={`${group.id}-${item.kind}`}
                          className={`fl-tree-child ${isItemActive ? "active" : ""}`}
                          onClick={() => handleSelectKind(item.kind)}
                        >
                          <span>{item.label}</span>
                        </div>
                      );
                    })}
                    {group.id === "crd" &&
                      crdGroups.map((cg) => {
                        const grpKey = `crd-group:${cg.group}`;
                        const grpOpen = Boolean(expandedGroups[grpKey]);
                        const grpHasActive = cg.items.some((i) => i.targetKind === activeKind);
                        return (
                          <div key={grpKey}>
                            <div
                              className={`fl-tree-child ${grpHasActive ? "active" : ""}`}
                              style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                              onClick={() => setExpandedGroups((prev) => ({ ...prev, [grpKey]: !prev[grpKey] }))}
                            >
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {cg.group}
                              </span>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                {grpOpen ? (
                                  <path d="M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z" />
                                ) : (
                                  <path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z" />
                                )}
                              </svg>
                            </div>
                            {grpOpen &&
                              cg.items.map((crItem) => {
                                const isCrActive = crItem.targetKind === activeKind;
                                return (
                                  <div
                                    key={crItem.targetKind}
                                    className={`fl-tree-child ${isCrActive ? "active" : ""}`}
                                    style={{ paddingLeft: 48 }}
                                    onClick={() => handleSelectKind(crItem.targetKind)}
                                  >
                                    <span>{crItem.kindLabel}</span>
                                  </div>
                                );
                              })}
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="fl-sidebar-resizer" onMouseDown={startSidebarResize} />
      </div>

      {/* Right Main Area */}
      <div className="fl-main">
        {/* Top Horizontal Sibling Tabs (Screenshot 2: Overview | Pods | Deployments | Daemon Sets | ...) */}
        {activeGroup && activeGroup.items && (
          <div className="fl-top-tabs">
            {activeGroup.items.map((item) => (
              <div
                key={item.kind}
                className={`fl-top-tab ${item.kind === activeKind ? "active" : ""}`}
                onClick={() => handleSelectKind(item.kind)}
              >
                {item.label}
              </div>
            ))}
          </div>
        )}

        {banner && (
          <div className={`fl-banner ${banner.isError ? "error" : ""}`}>
            <span>{banner.text}</span>
            <button
              style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer" }}
              onClick={() => setBanner(null)}
            >
              ✕
            </button>
          </div>
        )}

        {/* Subheader Bar: Pods | 2 items | Namespace: dengliu v | Search Pods... */}
        <div className="fl-subheader">
          <div className="fl-subheader-title">{currentViewLabel}</div>
          <div className="fl-subheader-count">
            {activeKind === "ClusterCatalog"
              ? `${catalogList.length} items`
              : activeKind === "Workspace"
                ? `${workspace.length} items`
                : activeKind === "Event"
                  ? `${(snapshot.events || []).length} items`
                  : activeKind === "HelmRelease"
                    ? `${(snapshot.helm_releases || []).length} items`
                    : `${filteredResources.length} items`}
          </div>
          <div className="fl-subheader-controls">
            {activeKind !== "ClusterCatalog" &&
              activeKind !== "Workspace" &&
              activeKind !== "Node" &&
              activeKind !== "Namespace" && (
                <div className="fl-ns-picker-wrap" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="fl-ns-picker-btn"
                    onClick={() => {
                      if (!nsMenuOpen && allAvailableNamespaces.length <= 3) {
                        sendToBackend({ op: "sync-cluster", context: snapshot.current_context });
                      }
                      setNsMenuOpen((v) => !v);
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      Namespace: {snapshot.all_namespaces ? "All Namespaces" : snapshot.current_namespace || "default"}
                    </span>
                    <span style={{ fontSize: 11, opacity: 0.7 }}>▾</span>
                  </button>
                  {nsMenuOpen && (
                    <div className="fl-ns-popover">
                      <input
                        className="fl-ns-search"
                        type="text"
                        placeholder={`Filter ${allAvailableNamespaces.length} namespaces…`}
                        value={nsSearch}
                        onChange={(e) => setNsSearch(e.target.value)}
                        autoFocus
                      />
                      <div className="fl-ns-list">
                        <div
                          className={`fl-ns-opt ${snapshot.all_namespaces ? "active" : ""}`}
                          onClick={() => {
                            setNsMenuOpen(false);
                            setNsSearch("");
                            handleSelectNamespace("__ALL__");
                          }}
                        >
                          <span>All Namespaces</span>
                          {snapshot.all_namespaces && <span>✓</span>}
                        </div>
                        {allAvailableNamespaces
                          .filter((ns) => !nsSearch.trim() || ns.toLowerCase().includes(nsSearch.trim().toLowerCase()))
                          .map((ns) => {
                            const isSelected = !snapshot.all_namespaces && ns === snapshot.current_namespace;
                            return (
                              <div
                                key={ns}
                                className={`fl-ns-opt ${isSelected ? "active" : ""}`}
                                onClick={() => {
                                  setNsMenuOpen(false);
                                  setNsSearch("");
                                  handleSelectNamespace(ns);
                                }}
                              >
                                <span>{ns}</span>
                                {isSelected && <span>✓</span>}
                              </div>
                            );
                          })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            <div className="fl-search-wrap">
              <input
                className="fl-search-box"
                type="text"
                placeholder={`Search ${currentViewLabel}...`}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <span className="fl-search-icon">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
                </svg>
              </span>
            </div>
            <button
              className="fl-icon-btn"
              title="Refresh"
              onClick={() => {
                setBanner({ text: `Refreshing ${currentViewLabel}…`, isError: false });
                sendToBackend({ op: "load-category", category: activeKind });
                sendToBackend({ op: "sync-cluster", context: snapshot.current_context });
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="fl-table-container">
          {activeKind === "WorkloadsOverview" || activeKind === "ClusterOverview" ? (
            <div className="fl-overview-cards">
              {[
                ["Pod", "Pods"],
                ["Deployment", "Deployments"],
                ["DaemonSet", "Daemon Sets"],
                ["StatefulSet", "Stateful Sets"],
                ["ReplicaSet", "Replica Sets"],
                ["Job", "Jobs"],
                ["CronJob", "Cron Jobs"],
                ["Service", "Services"],
                ["ConfigMap", "Config Maps"],
                ["Secret", "Secrets"],
              ].map(([k, label]) => {
                const count = (snapshot.resources || []).filter((r) => r.kind === k).length;
                return (
                  <div key={k} className="fl-overview-card" onClick={() => handleSelectKind(k)}>
                    <div className="fl-overview-card-title">{label}</div>
                    <div className="fl-overview-card-count">{count}</div>
                  </div>
                );
              })}
            </div>
          ) : activeKind === "ClusterCatalog" ? (
            <table className="fl-table">
              <thead>
                <tr>
                  {visibleCols.map((col) => (
                    <th key={col.id} style={{ width: getColWidth(col) }}>
                      {col.label}
                      <div className="fl-col-resizer" onMouseDown={(e) => startColResize(e, col)} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {catalogList
                  .filter(
                    (c) =>
                      !searchQuery.trim() ||
                      c.name.toLowerCase().includes(searchQuery.trim().toLowerCase()) ||
                      (c.distro || "").toLowerCase().includes(searchQuery.trim().toLowerCase()),
                  )
                  .map((c) => {
                    const isCur = c.name === snapshot.current_context;
                    return (
                      <tr
                        key={c.name}
                        className={isCur ? "selected" : ""}
                        onClick={() => handleSwitchContext(c.name, "Pod")}
                      >
                        {visibleCols.map((col) => {
                          if (col.id === "name") {
                            return (
                              <td key={col.id}>
                                <span
                                  className="fl-cluster-badge"
                                  style={{
                                    width: 22,
                                    height: 22,
                                    fontSize: 9,
                                    marginRight: 8,
                                    background: avatarColor(c.name),
                                  }}
                                >
                                  {shortBadge(c)}
                                </span>
                                <strong>{c.name}</strong>
                              </td>
                            );
                          }
                          if (col.id === "source") return <td key={col.id}>local</td>;
                          if (col.id === "labels") {
                            return (
                              <td key={col.id}>
                                <span className="fl-chip">file={c.source || "~/.kube/config"}</span>
                              </td>
                            );
                          }
                          if (col.id === "distro") return <td key={col.id}>{c.distro || "-"}</td>;
                          if (col.id === "version") return <td key={col.id}>{c.version || "-"}</td>;
                          if (col.id === "nodes") return <td key={col.id}>{c.nodes ?? "-"}</td>;
                          if (col.id === "status") {
                            return (
                              <td key={col.id}>
                                <span className={`fl-status-text ${isCur ? "ok" : ""}`}>
                                  {isCur ? "connected" : "disconnected"}
                                </span>
                              </td>
                            );
                          }
                          return <td key={col.id} />;
                        })}
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          ) : activeKind === "Event" ? (
            <table className="fl-table">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>Type</th>
                  <th style={{ width: 360 }}>Message</th>
                  <th style={{ width: 130 }}>Namespace</th>
                  <th style={{ width: 200 }}>Involved Object</th>
                  <th style={{ width: 80 }}>Count</th>
                  <th style={{ width: 90 }}>Age</th>
                </tr>
              </thead>
              <tbody>
                {(snapshot.events || []).map((ev, i) => (
                  <tr key={i}>
                    <td>
                      <span className={`fl-status-text ${ev.event_type === "Warning" ? "warn" : "ok"}`}>
                        {ev.event_type}
                      </span>
                    </td>
                    <td title={ev.message}>{ev.message}</td>
                    <td>{ev.namespace}</td>
                    <td className="fl-link-teal">
                      {ev.kind}: {ev.object}
                    </td>
                    <td>{ev.count}</td>
                    <td>{formatCompactAge(ev.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : activeKind === "Workspace" ? (
            <table className="fl-table">
              <thead>
                <tr>
                  <th style={{ width: 140 }}>Kind</th>
                  <th style={{ width: 220 }}>Name</th>
                  <th style={{ width: 130 }}>Namespace</th>
                  <th>File</th>
                </tr>
              </thead>
              <tbody>
                {workspace.map((w, i) => (
                  <tr key={i} onClick={() => sendToBackend({ op: "open-location", path: w.fullPath, line: w.line })}>
                    <td>{w.kind}</td>
                    <td>{w.name}</td>
                    <td>{w.namespace}</td>
                    <td className="fl-link-teal">
                      {w.path}:{w.line + 1}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="fl-table">
              <thead>
                <tr>
                  {activeKind !== "Node" && (
                    <th style={{ width: 38, textAlign: "center" }}>
                      <input
                        type="checkbox"
                        onChange={(e) => {
                          const next: Record<string, boolean> = {};
                          if (e.target.checked) {
                            for (const r of filteredResources) next[`${r.kind}:${r.namespace}/${r.name}`] = true;
                          }
                          setCheckedRows(next);
                        }}
                      />
                    </th>
                  )}
                  {visibleCols.map((col) => (
                    <th
                      key={col.id}
                      className="sortable"
                      style={{ width: getColWidth(col), textAlign: col.align || "left" }}
                      onClick={() => {
                        if (sortCol === col.id) setSortAsc((v) => !v);
                        else {
                          setSortCol(col.id);
                          setSortAsc(true);
                        }
                      }}
                    >
                      <span>{col.label}</span>
                      {sortCol === col.id && <span style={{ marginLeft: 4, fontSize: 10 }}>{sortAsc ? "▴" : "▾"}</span>}
                      <div className="fl-col-resizer" onMouseDown={(e) => startColResize(e, col)} />
                    </th>
                  ))}
                  <th style={{ width: 48, textAlign: "right", paddingRight: 12 }}>
                    <button
                      className="fl-col-menu-btn"
                      title="Customize table columns"
                      onClick={(e) => {
                        e.stopPropagation();
                        setColMenuOpen((v) => !v);
                      }}
                    >
                      ⋮
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredResources.length === 0 ? (
                  <tr>
                    <td
                      colSpan={visibleCols.length + (activeKind === "Node" ? 1 : 2)}
                      style={{ textAlign: "center", padding: "32px 16px", color: "var(--fl-fg-muted)" }}
                    >
                      {banner && !banner.isError
                        ? banner.text
                        : `No ${currentViewLabel} found in ${
                            snapshot.all_namespaces ? "any namespace" : `namespace "${snapshot.current_namespace}"`
                          }.`}
                    </td>
                  </tr>
                ) : (
                  filteredResources.map((res) => {
                    const rowKey = `${res.kind}:${res.namespace}/${res.name}`;
                    const isSel = rowKey === selectedRowKey && drawerOpen;
                    return (
                      <tr
                        key={rowKey}
                        className={isSel ? "selected" : ""}
                        onClick={() => openResourceDrawer(res, "overview")}
                      >
                        {activeKind !== "Node" && (
                          <td style={{ textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={Boolean(checkedRows[rowKey])}
                              onChange={(e) => setCheckedRows((prev) => ({ ...prev, [rowKey]: e.target.checked }))}
                            />
                          </td>
                        )}
                        {visibleCols.map((col) => (
                          <td key={col.id} style={{ textAlign: col.align || "left" }}>
                            {renderPodCell(res, col.id)}
                          </td>
                        ))}
                        <td style={{ textAlign: "right", paddingRight: 14 }} onClick={(e) => e.stopPropagation()}>
                          <button
                            style={{
                              border: "none",
                              background: "transparent",
                              color: "var(--fl-fg-muted)",
                              cursor: "pointer",
                              fontSize: 15,
                            }}
                            title="Edit Live YAML"
                            onClick={() => openResourceDrawer(res, "yaml")}
                          >
                            ⋮
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Floating Column Visibility & Order Popover (Screenshot 1 right side) */}
        {colMenuOpen && (
          <div className="fl-col-popover" onClick={(e) => e.stopPropagation()}>
            {orderedCols.map((col, idx) => {
              const visMap = colVisByKind[activeKind] || {};
              const checked = visMap[col.id] !== undefined ? visMap[col.id] : col.defaultVisible;
              return (
                <div key={col.id} className="fl-col-popover-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={col.id === "name"}
                      onChange={() => toggleColVisible(col.id)}
                    />
                    <span>{col.label}</span>
                  </label>
                  <span className="fl-col-move-btns">
                    <button
                      className="fl-col-move-btn"
                      title="Move column left"
                      disabled={idx === 0}
                      onClick={() => moveColumn(col.id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      className="fl-col-move-btn"
                      title="Move column right"
                      disabled={idx === orderedCols.length - 1}
                      onClick={() => moveColumn(col.id, 1)}
                    >
                      ↓
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Slide-Over Right Detail Drawer (Screenshot 2) */}
        {drawerOpen && selectedResource && (
          <div
            className="fl-drawer"
            style={{ width: drawerWidth }}
            onClick={(e) => {
              e.stopPropagation();
              setLogContainerMenuOpen(false);
              setShellContainerMenuOpen(false);
            }}
          >
            <div className="fl-drawer-resizer" onMouseDown={startDrawerResize} />
            <div className="fl-drawer-header">
              <div className="fl-drawer-title">
                {selectedResource.kind.startsWith("CR:")
                  ? selectedResource.controlled_by_kind || selectedResource.kind.slice(3)
                  : selectedResource.kind}
                : {selectedResource.name}
              </div>
              <div className="fl-drawer-actions">
                {selectedResource.kind !== "Node" && (
                  <button
                    className={`fl-drawer-act-btn ${drawerMode === "overview" ? "active" : ""}`}
                    title="Properties Overview"
                    onClick={() => openResourceDrawer(selectedResource, "overview")}
                  >
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <rect x="2" y="3.5" width="16" height="13" rx="2.5" fill="#ffffff" />
                      <circle cx="9.2" cy="9.5" r="2.7" stroke="var(--fl-teal)" strokeWidth="1.8" />
                      <line
                        x1="11.3"
                        y1="11.6"
                        x2="13.8"
                        y2="14.1"
                        stroke="var(--fl-teal)"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                )}
                {selectedResource.kind === "Node" && (
                  <>
                    <button
                      className={`fl-drawer-act-btn ${drawerMode === "shell" ? "active" : ""}`}
                      title="Node Shell"
                      onClick={() => setDrawerMode((m) => (m === "shell" ? "overview" : "shell"))}
                    >
                      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                        <rect x="2.5" y="2.5" width="15" height="15" rx="2.5" fill="#ffffff" />
                        <path
                          d="M6 7.4L9.2 10L6 12.6"
                          stroke="var(--fl-teal)"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <line
                          x1="10.2"
                          y1="12.8"
                          x2="14"
                          y2="12.8"
                          stroke="var(--fl-teal)"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                        />
                      </svg>
                    </button>
                    {(() => {
                      const isCordoned =
                        selectedResource.status.includes("SchedulingDisabled") ||
                        Boolean(drawerJson?.spec?.unschedulable);
                      return (
                        <button
                          className="fl-drawer-act-btn"
                          title={isCordoned ? "Uncordon" : "Cordon"}
                          onClick={() => {
                            setBanner({
                              text: `${isCordoned ? "Uncordoning" : "Cordoning"} node ${selectedResource.name}…`,
                              isError: false,
                            });
                            sendToBackend({
                              op: "cordon-node",
                              name: selectedResource.name,
                              uncordon: isCordoned,
                            });
                          }}
                        >
                          {isCordoned ? (
                            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                              <circle cx="10" cy="10" r="7.5" fill="#ffffff" />
                              <path d="M8.2 6.8L13.5 10L8.2 13.2V6.8Z" fill="var(--fl-teal)" />
                            </svg>
                          ) : (
                            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                              <circle cx="10" cy="10" r="7.5" fill="#ffffff" />
                              <rect x="7.5" y="6.8" width="1.8" height="6.4" rx="0.5" fill="var(--fl-teal)" />
                              <rect x="10.7" y="6.8" width="1.8" height="6.4" rx="0.5" fill="var(--fl-teal)" />
                            </svg>
                          )}
                        </button>
                      );
                    })()}
                    <button
                      className="fl-drawer-act-btn"
                      title="Drain"
                      onClick={() => {
                        setBanner({
                          text: `Draining node ${selectedResource.name}…`,
                          isError: false,
                        });
                        sendToBackend({
                          op: "drain-node",
                          name: selectedResource.name,
                        });
                      }}
                    >
                      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                        <path
                          d="M12.5 13h3.2v1.6h-3.2V13zm0-6.4h5v1.6h-5V6.6zm0 3.2h4.2v1.6h-4.2V9.8zM3.2 14.6c0 .88.72 1.6 1.6 1.6h4.8c.88 0 1.6-.72 1.6-1.6V6.6H3.2v8zm8.8-10.4H9.6l-.8-.8H5.6l-.8.8H2.4v1.6H12V4.2z"
                          fill="#ffffff"
                        />
                      </svg>
                    </button>
                  </>
                )}
                {selectedResource.kind === "Pod" && (
                  <>
                    <div className="fl-drawer-act-wrap" onClick={(e) => e.stopPropagation()}>
                      <button
                        className={`fl-drawer-act-btn ${drawerMode === "shell" || shellContainerMenuOpen ? "active" : ""}`}
                        title="Pod Shell"
                        onClick={() => {
                          setLogContainerMenuOpen(false);
                          const items = getPodContainerItems(selectedResource, drawerJson);
                          if (items.length > 1) {
                            setShellContainerMenuOpen((v) => !v);
                          } else {
                            setLogContainer(items[0]?.name || "");
                            setDrawerMode("shell");
                          }
                        }}
                      >
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                          <rect x="2.5" y="2.5" width="15" height="15" rx="2.5" fill="#ffffff" />
                          <path
                            d="M6 7.4L9.2 10L6 12.6"
                            stroke="var(--fl-teal)"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                          <line
                            x1="10.2"
                            y1="12.8"
                            x2="14"
                            y2="12.8"
                            stroke="var(--fl-teal)"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                      {shellContainerMenuOpen && (
                        <div className="fl-container-menu">
                          {getPodContainerItems(selectedResource, drawerJson).map((c) => (
                            <div
                              key={c.name}
                              className="fl-container-menu-item"
                              onClick={() => {
                                setShellContainerMenuOpen(false);
                                setLogContainer(c.name);
                                setDrawerMode("shell");
                              }}
                            >
                              <span className={`fl-csq ${c.cls}`} />
                              <span>{c.name}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="fl-drawer-act-wrap" onClick={(e) => e.stopPropagation()}>
                      <button
                        className={`fl-drawer-act-btn ${logContainerMenuOpen ? "active" : ""}`}
                        title="Pod Logs"
                        onClick={() => {
                          setShellContainerMenuOpen(false);
                          const items = getPodContainerItems(selectedResource, drawerJson);
                          if (items.length > 1) {
                            setLogContainerMenuOpen((v) => !v);
                          } else {
                            openPodLogsInEditorTab(selectedResource, items[0]?.name || "");
                          }
                        }}
                      >
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                          <rect x="2.5" y="4" width="15" height="2.2" rx="0.8" fill="#ffffff" />
                          <rect x="2.5" y="7.8" width="15" height="2.2" rx="0.8" fill="#ffffff" />
                          <rect x="2.5" y="11.6" width="15" height="2.2" rx="0.8" fill="#ffffff" />
                          <rect x="2.5" y="15.4" width="10" height="2.2" rx="0.8" fill="#ffffff" />
                        </svg>
                      </button>
                      {logContainerMenuOpen && (
                        <div className="fl-container-menu">
                          {getPodContainerItems(selectedResource, drawerJson).map((c) => (
                            <div
                              key={c.name}
                              className="fl-container-menu-item"
                              onClick={() => {
                                setLogContainerMenuOpen(false);
                                openPodLogsInEditorTab(selectedResource, c.name);
                              }}
                            >
                              <span className={`fl-csq ${c.cls}`} />
                              <span>{c.name}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
                {(selectedResource.kind === "Pod" || selectedResource.kind === "Service") && (
                  <button
                    className="fl-drawer-act-btn"
                    title="Port Forward (kubectl port-forward)"
                    onClick={() => {
                      const port = (selectedResource.ports && selectedResource.ports[0]) || "8080";
                      setBanner({
                        text: `Starting port-forward for ${selectedResource.kind}/${selectedResource.name} (${port})…`,
                        isError: false,
                      });
                      sendToBackend({
                        op: "port-forward",
                        kind: selectedResource.kind,
                        namespace: selectedResource.namespace,
                        name: selectedResource.name,
                        port,
                      });
                    }}
                  >
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <path
                        d="M5 7h10m0 0l-2.5-2.5M15 7l-2.5 2.5M15 13H5m0 0l2.5-2.5M5 13l2.5 2.5"
                        stroke="#ffffff"
                        strokeWidth="1.9"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                )}
                {["Deployment", "StatefulSet", "DaemonSet"].includes(selectedResource.kind) && (
                  <button
                    className="fl-drawer-act-btn"
                    title="Rollout Restart Workload"
                    onClick={() =>
                      sendToBackend({
                        op: "restart",
                        kind: selectedResource.kind,
                        namespace: selectedResource.namespace,
                        name: selectedResource.name,
                      })
                    }
                  >
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <path
                        d="M15.5 10a5.5 5.5 0 1 1-1.6-3.9L15.5 7.7M15.5 4.2v3.5H12"
                        stroke="#ffffff"
                        strokeWidth="1.9"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                )}
                {selectedResource.kind === "CronJob" && (
                  <>
                    <button
                      className="fl-drawer-act-btn"
                      title="Trigger CronJob Now"
                      onClick={() => {
                        setBanner({
                          text: `Triggering manual Job from CronJob/${selectedResource.name}…`,
                          isError: false,
                        });
                        sendToBackend({
                          op: "trigger-cronjob",
                          namespace: selectedResource.namespace,
                          name: selectedResource.name,
                        });
                      }}
                    >
                      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                        <path d="M6.5 5.2L15 10L6.5 14.8V5.2Z" fill="#ffffff" />
                      </svg>
                    </button>
                    {(() => {
                      const isSuspended = selectedResource.status === "Suspended" || Boolean(drawerJson?.spec?.suspend);
                      return (
                        <button
                          className="fl-drawer-act-btn"
                          title={isSuspended ? "Resume CronJob" : "Suspend CronJob"}
                          onClick={() => {
                            sendToBackend({
                              op: "suspend-cronjob",
                              namespace: selectedResource.namespace,
                              name: selectedResource.name,
                              suspend: !isSuspended,
                            });
                          }}
                        >
                          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                            <circle cx="10" cy="10" r="7.5" fill="#ffffff" />
                            {isSuspended ? (
                              <path d="M8.2 6.8L13.5 10L8.2 13.2V6.8Z" fill="var(--fl-teal)" />
                            ) : (
                              <>
                                <rect x="7.5" y="6.8" width="1.8" height="6.4" rx="0.5" fill="var(--fl-teal)" />
                                <rect x="10.7" y="6.8" width="1.8" height="6.4" rx="0.5" fill="var(--fl-teal)" />
                              </>
                            )}
                          </svg>
                        </button>
                      );
                    })()}
                  </>
                )}
                <button
                  className="fl-drawer-act-btn"
                  title="Edit Live YAML in Editor Tab"
                  onClick={() => openResourceYamlInEditorTab(selectedResource)}
                >
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path
                      d="M3 14.25V17h2.75L13.86 8.89l-2.75-2.75L3 14.25zM16.71 6.04a.75.75 0 0 0 0-1.06l-1.69-1.69a.75.75 0 0 0-1.06 0l-1.32 1.32 2.75 2.75 1.32-1.32z"
                      fill="#ffffff"
                    />
                  </svg>
                </button>
                <button
                  className="fl-drawer-act-btn"
                  title="Delete Resource"
                  onClick={() => {
                    sendToBackend({
                      op: "delete",
                      kind: selectedResource.kind,
                      namespace: selectedResource.namespace,
                      name: selectedResource.name,
                    });
                    setDrawerOpen(false);
                  }}
                >
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path
                      d="M5.5 16.5c0 .83.67 1.5 1.5 1.5h6c.83 0 1.5-.67 1.5-1.5v-9h-9v9zM15.25 4.5h-2.62l-.75-.75h-3.76l-.75.75H4.75V6h10.5V4.5z"
                      fill="#ffffff"
                    />
                  </svg>
                </button>
                <button className="fl-drawer-act-btn" title="Close" onClick={() => setDrawerOpen(false)}>
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M5 5l10 10M15 5L5 15" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            </div>

            {drawerMode === "shell" ? (
              <div className="fl-pod-shell">
                {(selectedResource.containers?.length ?? 0) > 1 && (
                  <div className="fl-shell-toolbar">
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ color: "#8b949e" }}>Container:</span>
                      <select
                        className="fl-ns-select"
                        style={{
                          minWidth: 120,
                          height: 26,
                          background: "#21262d",
                          color: "#e6edf3",
                          borderColor: "#30363d",
                        }}
                        value={logContainer || selectedResource.containers?.[0] || ""}
                        onChange={(e) => setLogContainer(e.target.value)}
                      >
                        {(selectedResource.containers || []).map((c: string) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
                <PodTerminal
                  kind={selectedResource.kind === "Node" ? "Node" : "Pod"}
                  context={snapshot.current_context}
                  namespace={selectedResource.namespace || snapshot.current_namespace || "default"}
                  pod={selectedResource.name}
                  container={
                    logContainer ||
                    selectedResource.containers?.[0] ||
                    drawerJson?.metadata?.annotations?.["kubectl.kubernetes.io/default-container"] ||
                    drawerJson?.spec?.containers?.[0]?.name ||
                    ""
                  }
                />
              </div>
            ) : drawerMode === "yaml" ? (
              <div className="fl-yaml-editor-wrap">
                <div className="fl-yaml-toolbar">
                  <span style={{ fontSize: 12, fontWeight: 600 }}>
                    Live YAML — {selectedResource.kind}/{selectedResource.name}
                  </span>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="fl-icon-btn" onClick={() => openResourceDrawer(selectedResource, "yaml")}>
                      Reload
                    </button>
                    <button
                      className="fl-icon-btn"
                      onClick={() => {
                        setDrawerMode("describe");
                        setDrawerRawText("Running kubectl diff -f -…");
                        sendToBackend({ op: "diff-yaml", yaml: yamlDraft });
                      }}
                    >
                      Diff
                    </button>
                    <button
                      className="fl-icon-btn"
                      style={{ background: "var(--fl-teal)", color: "#fff", borderColor: "var(--fl-teal)" }}
                      onClick={() => {
                        setBanner({ text: "Applying edited YAML to cluster…", isError: false });
                        sendToBackend({ op: "apply-yaml", yaml: yamlDraft });
                      }}
                    >
                      Save &amp; Apply
                    </button>
                  </div>
                </div>
                <textarea
                  className="fl-yaml-textarea"
                  value={yamlDraft}
                  onChange={(e) => setYamlDraft(e.target.value)}
                  spellCheck={false}
                />
              </div>
            ) : drawerMode === "logs" ? (
              <div className="fl-yaml-editor-wrap">
                <div className="fl-yaml-toolbar">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span>Container:</span>
                    <select
                      className="fl-ns-select"
                      style={{ minWidth: 120, height: 28 }}
                      value={logContainer}
                      onChange={(e) => {
                        setLogContainer(e.target.value);
                        sendToBackend({
                          op: "pod-logs",
                          namespace: selectedResource.namespace,
                          name: selectedResource.name,
                          container: e.target.value || null,
                          previous: logPrevious,
                        });
                      }}
                    >
                      {(selectedResource.containers || []).map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={logPrevious}
                        onChange={(e) => {
                          setLogPrevious(e.target.checked);
                          sendToBackend({
                            op: "pod-logs",
                            namespace: selectedResource.namespace,
                            name: selectedResource.name,
                            container: logContainer || null,
                            previous: e.target.checked,
                          });
                        }}
                      />
                      Previous
                    </label>
                  </div>
                  <button
                    className="fl-icon-btn"
                    title="Open live streaming Pod logs (kubectl logs -f) in a regular Editor tab"
                    onClick={() => {
                      const container = logContainer || selectedResource.containers?.[0] || "";
                      const ns = selectedResource.namespace || snapshot.current_namespace || "default";
                      const ctx = snapshot.current_context;
                      const baseArgs: string[] = [];
                      if (ctx) baseArgs.push(`--context=${ctx}`);
                      if (ns) baseArgs.push("-n", ns);
                      baseArgs.push("logs", "-f", "--tail=500", selectedResource.name);
                      if (container) baseArgs.push("-c", container);
                      const title = container
                        ? `Logs: ${selectedResource.name} (${container})`
                        : `Logs: ${selectedResource.name}`;
                      const key = `pluginLog:openidea.kubernetes:${ctx}:${ns}:${selectedResource.name}:${container}`;
                      sendToBackend({
                        op: "open-log-tab",
                        key,
                        title,
                        program: "kubectl",
                        baseArgs,
                        toggles: [
                          { id: "timestamps", label: "Timestamps", args: ["--timestamps=true"] },
                          { id: "previous", label: "Previous", args: ["--previous"] },
                        ],
                      });
                    }}
                  >
                    Follow in Editor Tab
                  </button>
                </div>
                <DrawerLogViewer text={drawerRawText} />
              </div>
            ) : drawerMode === "describe" ? (
              <pre className="fl-pre-output" style={{ flex: 1, overflow: "auto" }}>
                {drawerRawText}
              </pre>
            ) : (
              /* Structured Freelens Properties Drawer (Screenshot 2) */
              <div className="fl-drawer-body">
                {["Pod", "Node", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"].includes(
                  selectedResource.kind,
                ) && (
                  <div className="fl-metrics-box">
                    <select className="fl-ns-select" style={{ width: "100%", height: 30 }}>
                      <option>1 hour</option>
                      <option>6 hours</option>
                      <option>24 hours</option>
                    </select>
                    <div className="fl-metrics-tabs">
                      {(["CPU", "Memory", "Network", "Filesystem"] as const).map((t) => (
                        <div
                          key={t}
                          className={`fl-metrics-tab ${activeMetricTab === t ? "active" : ""}`}
                          onClick={() => setActiveMetricTab(t)}
                        >
                          {t}
                        </div>
                      ))}
                    </div>
                    <div className="fl-metrics-empty">
                      {selectedResource.cpu || selectedResource.memory
                        ? `Live usage — CPU: ${selectedResource.cpu || "N/A"} cores • Memory: ${selectedResource.memory || "N/A"}`
                        : "ⓘ Metrics not available at the moment"}
                    </div>
                  </div>
                )}

                <ResourceDetails
                  selectedResource={selectedResource}
                  drawerJson={drawerJson}
                  allResources={snapshot.resources || []}
                  allEvents={snapshot.events || []}
                  extraPods={drawerExtraPods}
                  extraResources={drawerExtraResources}
                  extraEvents={drawerExtraEvents}
                  formatCreatedDetailed={formatCreatedDetailed}
                  formatAgeShort={formatCompactAge}
                  statusClass={statusClass}
                  onSelectNamespace={handleSelectNamespace}
                  onSelectKind={handleSelectKind}
                  onOpenResourceByRef={openResourceByRef}
                  onPortForward={(kind, ns, name, port) => {
                    setBanner({
                      text: `Starting port-forward for ${kind}/${name} (${port})…`,
                      isError: false,
                    });
                    sendToBackend({
                      op: "port-forward",
                      kind,
                      namespace: ns,
                      name,
                      port,
                    });
                  }}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
