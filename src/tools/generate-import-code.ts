import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const FRAMEWORKS = ["vanilla-js", "react", "vue", "angular"] as const;
type Framework = (typeof FRAMEWORKS)[number];

const LICENSE = "YOUR_SHEET_LICENSE_KEY";

const TEMPLATES: Record<Framework, string> = {
  "vanilla-js": `<!-- CSVBox Vanilla JS integration -->
<button id="csvbox-import-btn">Import CSV</button>

<script src="https://js.csvbox.io/script.js"></script>
<script>
  // 1. Create the importer with your sheet license key.
  const importer = new CSVBoxImporter(
    "${LICENSE}",
    {},
    function (result, data) {
      if (result) {
        console.log("Import successful:", data);
      } else {
        console.log("Import failed:", data);
      }
    },
    {
      // Optional theme / language overrides
      lazy: false,
    }
  );

  // 2. Identify the end user (optional but recommended).
  importer.setUser({ user_id: "default123" });

  // 3. Open the importer on click.
  document
    .getElementById("csvbox-import-btn")
    .addEventListener("click", function () {
      importer.openModal();
    });
</script>`,

  react: `// CSVBox React integration
// Install: npm install @csvbox/react
import React from "react";
import { CSVBoxButton } from "@csvbox/react";

export default function CsvImportButton() {
  return (
    <CSVBoxButton
      licenseKey="${LICENSE}"
      user={{ user_id: "default123" }}
      onImport={(result, data) => {
        if (result) {
          console.log("Import successful:", data);
        } else {
          console.log("Import failed:", data);
        }
      }}
      render={(launch, isLoading) => (
        <button onClick={() => launch()} disabled={isLoading}>
          {isLoading ? "Loading..." : "Import CSV"}
        </button>
      )}
    >
      Import CSV
    </CSVBoxButton>
  );
}`,

  vue: `<!-- CSVBox Vue 3 integration -->
<!-- Install: npm install @csvbox/vuejs -->
<template>
  <CSVBoxButton
    :licenseKey="licenseKey"
    :user="user"
    :onImport="onImport"
  >
    Import CSV
  </CSVBoxButton>
</template>

<script>
import { CSVBoxButton } from "@csvbox/vuejs";

export default {
  name: "CsvImportButton",
  components: { CSVBoxButton },
  data() {
    return {
      licenseKey: "${LICENSE}",
      user: { user_id: "default123" },
    };
  },
  methods: {
    onImport(result, data) {
      if (result) {
        console.log("Import successful:", data);
      } else {
        console.log("Import failed:", data);
      }
    },
  },
};
</script>`,

  angular: `// CSVBox Angular integration
// Install: npm install @csvbox/angular
// Import CSVBoxAngularModule in your NgModule.
import { Component } from "@angular/core";

@Component({
  selector: "app-csv-import",
  template: \`
    <csvbox-button
      [licenseKey]="licenseKey"
      [user]="user"
      (onImport)="onImport($event)"
    >
      Import CSV
    </csvbox-button>
  \`,
})
export class CsvImportComponent {
  licenseKey = "${LICENSE}";
  user = { user_id: "default123" };

  onImport(event: { success: boolean; data: unknown }) {
    if (event.success) {
      console.log("Import successful:", event.data);
    } else {
      console.log("Import failed:", event.data);
    }
  }
}`,
};

const inputShape = {
  framework: z
    .enum(FRAMEWORKS)
    .describe("Target framework: vanilla-js | react | vue | angular."),
};

export function registerGenerateImportCode(server: McpServer): void {
  server.registerTool(
    "generate_import_code",
    {
      title: "Generate CSVBox Integration Code",
      description:
        "Generate complete CSVBox importer integration code for a framework (vanilla-js, react, vue, angular). Input: { framework }. Replace the license key placeholder with your sheet's license key.",
      inputSchema: inputShape,
    },
    async ({ framework }) => {
      try {
        const code = TEMPLATES[framework as Framework];
        if (!code) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: `Unsupported framework "${framework}".`,
                    supported: FRAMEWORKS,
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Framework: ${framework}\nReplace "${LICENSE}" with your sheet's license key.\n\n${code}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { error: err instanceof Error ? err.message : String(err) },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
