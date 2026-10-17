import { useEffect, useState } from "react";

export interface PwaInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export interface PwaInstallState {
  canInstall: boolean;
  installed: boolean;
  install(): Promise<"accepted" | "dismissed" | "unavailable">;
}

function alreadyInstalled(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches === true;
}

export function usePwaInstall(): PwaInstallState {
  const [prompt, setPrompt] = useState<PwaInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(alreadyInstalled);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPrompt(event as PwaInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  return {
    canInstall: prompt !== null && !installed,
    installed,
    async install() {
      if (!prompt) return "unavailable";
      await prompt.prompt();
      const choice = await prompt.userChoice;
      setPrompt(null);
      if (choice.outcome === "accepted") setInstalled(true);
      return choice.outcome;
    },
  };
}
