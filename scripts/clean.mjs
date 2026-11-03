import { rm } from "node:fs/promises";

const generatedPaths = [
  "dist",
  "dist-electron",
  "dist-native",
  "dist-server",
  "release",
  "native/helpers/speech-helper",
  "native/helpers/BotFleet Speech.app",
  "native/helpers/BotFleet Recorder.app",
  "electron/resources/BotFleet Control.app",
];

await Promise.all(
  generatedPaths.map((path) => rm(path, { recursive: true, force: true })),
);
