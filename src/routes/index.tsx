import { createFileRoute } from "@tanstack/react-router";
import { RecorderApp } from "@/components/recorder/recorder-app";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return <RecorderApp />;
}
