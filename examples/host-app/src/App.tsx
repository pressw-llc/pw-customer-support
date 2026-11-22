import { SupportWidget } from "@pressw-llc/support-react";

const params = new URLSearchParams(window.location.search);
const signedInEmail =
  params.get("email") ?? import.meta.env.VITE_SUPPORT_USER_EMAIL;
const pollIntervalMs = Number(params.get("poll")) || undefined;

export default function App() {
  return (
    <main
      style={{
        fontFamily: "Georgia, serif",
        margin: "3rem auto",
        maxWidth: 640,
      }}
    >
      <h1>Acme Portal</h1>
      <p>
        This page stands in for a customer application. The support widget needs
        one import and two props.
      </p>
      <SupportWidget
        projectKey={import.meta.env.VITE_SUPPORT_PROJECT_KEY}
        userEmail={signedInEmail}
        apiUrl={import.meta.env.VITE_SUPPORT_API_URL}
        pollIntervalMs={pollIntervalMs}
      />
    </main>
  );
}
