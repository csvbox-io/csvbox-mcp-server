import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const FRAMEWORKS = [
  "vanilla-js",
  "react",
  "vuejs2",
  "vuejs3",
  "angular",
  "angular2",
] as const;
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

  vuejs2: `<!-- CSVBox Vue 2 integration -->
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

  vuejs3: `<!-- CSVBox Vue 3 integration -->
<!-- Install: npm install @csvbox/vuejs3 -->
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
import CSVBoxButton from "@csvbox/vuejs3";

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

  angular: `// CSVBox Angular integration (Angular 8-13)
// Install: npm install @csvbox/angular
import { Component } from "@angular/core";
import { CSVBoxAngularModule } from "@csvbox/angular";

@NgModule({
  imports: [CSVBoxAngularModule],
})
export class AppModule {}

@Component({
  selector: "app-csv-import",
  template: \`
    <csvbox-button
      [licenseKey]="licenseKey"
      [user]="user"
      [isImported]="isImported.bind(this)"
    >
      Import CSV
    </csvbox-button>
  \`,
})
export class CsvImportComponent {
  licenseKey = "${LICENSE}";
  user = { user_id: "default123" };

  // Fires once the widget has initialized.
  isReady() {
    console.log("Importer ready");
  }

  // Fires when the widget is closed.
  isClosed() {
    console.log("Importer closed");
  }

  // Fires when the user submits, before the import completes.
  isSubmitted(metadata: unknown) {
    console.log("Submitted:", metadata);
  }

  // Fires when the import completes.
  isImported(result: boolean, data: unknown) {
    if (result) {
      console.log("Import successful:", data);
    } else {
      console.log("Import failed:", data);
    }
  }
}`,

  angular2: `// CSVBox Angular integration (Angular 14+)
// Install: npm install @csvbox/angular2
import { Component } from "@angular/core";
import { CSVBoxButtonComponent } from "@csvbox/angular2";

@Component({
  selector: "app-csv-import",
  standalone: true,
  imports: [CSVBoxButtonComponent],
  template: \`
    <csvbox-button
      [licenseKey]="licenseKey"
      [user]="user"
      [isImported]="isImported.bind(this)"
    >
      Import CSV
    </csvbox-button>
  \`,
})
export class CsvImportComponent {
  licenseKey = "${LICENSE}";
  user = { user_id: "default123" };

  // Fires once the widget has initialized.
  isReady() {
    console.log("Importer ready");
  }

  // Fires when the widget is closed.
  isClosed() {
    console.log("Importer closed");
  }

  // Fires when the user submits, before the import completes.
  isSubmitted(metadata: unknown) {
    console.log("Submitted:", metadata);
  }

  // Fires when the import completes.
  isImported(result: boolean, data: unknown) {
    if (result) {
      console.log("Import successful:", data);
    } else {
      console.log("Import failed:", data);
    }
  }
}`,
};

const inputShape = {
  framework: z
    .enum(FRAMEWORKS)
    .describe(
      "Target framework: vanilla-js | react | vuejs2 (Vue 2) | vuejs3 (Vue 3) | angular (Angular 8-13) | angular2 (Angular 14+)."
    ),
};

export function registerGenerateImportCode(server: McpServer): void {
  server.registerTool(
    "generate_import_code",
    {
      title: "Generate CSVBox Integration Code",
      description:
        "Generate complete CSVBox importer integration code for a framework (vanilla-js, react, vuejs2 [Vue 2], vuejs3 [Vue 3], angular [Angular 8-13], angular2 [Angular 14+]). Input: { framework }. Replace the license key placeholder with your sheet's license key.",
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
