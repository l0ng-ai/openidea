import { lazyPage } from "./lazyPage";
import type { PageSpec } from "./spec";
import { TOOLS_GROUP } from "./tools";

const SshConfigsEditor = lazyPage("tools.sshConfigurations", () => import("./SshBody").then((m) => m.SshConfigsEditor));

export const SSH_PAGES: PageSpec[] = [
  {
    id: "tools.sshConfigurations",
    title: "SSH Configurations",
    group: TOOLS_GROUP,
    order: 603,
    keywords: ["ssh", "remote", "host", "server", "key pair", "private key", "password", "known_hosts", "agent"],
    sections: [
      {
        options: [
          {
            kind: "custom",
            label: "SSH Configurations",
            keywords: [
              "Host",
              "Port",
              "User name",
              "Authentication type",
              "Private key file",
              "Password",
              "Passphrase",
              "Save password",
              "Save passphrase",
              "Test Connection",
              "OpenSSH config and authentication agent",
            ],
            component: SshConfigsEditor,
          },
        ],
      },
    ],
  },
];
