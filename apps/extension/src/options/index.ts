import { getSettings, saveSettings, type Settings } from "@/lib/storage";

const form = document.getElementById("settings") as HTMLFormElement;
const saved = document.getElementById("saved") as HTMLElement;

function readForm(): Partial<Settings> {
  const fd = new FormData(form);
  return {
    endpoint: String(fd.get("endpoint") ?? ""),
    enabled: fd.get("enabled") === "on",
    capture: {
      "job-search": fd.get("capture-job-search") === "on",
      "job-detail": fd.get("capture-job-detail") === "on",
      "category-feed": fd.get("capture-category-feed") === "on",
    },
  };
}

function paint(s: Settings): void {
  (form.elements.namedItem("endpoint") as HTMLInputElement).value = s.endpoint;
  (form.elements.namedItem("enabled") as HTMLInputElement).checked = s.enabled;
  (form.elements.namedItem("capture-job-search") as HTMLInputElement).checked = s.capture["job-search"];
  (form.elements.namedItem("capture-job-detail") as HTMLInputElement).checked = s.capture["job-detail"];
  (form.elements.namedItem("capture-category-feed") as HTMLInputElement).checked = s.capture["category-feed"];
}

void getSettings().then(paint);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  await saveSettings(readForm());
  saved.hidden = false;
  setTimeout(() => (saved.hidden = true), 1500);
});
