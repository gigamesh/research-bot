import { getSettings, saveSettings, type Settings } from "@/lib/storage";

const form = document.getElementById("settings") as HTMLFormElement;
const saved = document.getElementById("saved") as HTMLElement;

function readForm(): Partial<Settings> {
  const fd = new FormData(form);
  return {
    endpoint: String(fd.get("endpoint") ?? ""),
    enabled: fd.get("enabled") === "on",
  };
}

function paint(s: Settings): void {
  (form.elements.namedItem("endpoint") as HTMLInputElement).value = s.endpoint;
  (form.elements.namedItem("enabled") as HTMLInputElement).checked = s.enabled;
}

void getSettings().then(paint);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  await saveSettings(readForm());
  saved.hidden = false;
  setTimeout(() => (saved.hidden = true), 1500);
});
