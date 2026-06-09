// Brand logos for integrations, rendered as inline SVG so they scale crisply
// and pick up no external assets. Keyed by integration id.

import type { ReactNode, SVGProps } from "react";

function AnthropicIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        fill="currentColor"
        d="M32.2 10h-5.8l10.6 28h5.8L32.2 10ZM15.8 10 5.2 38h5.9l2.2-6.2h11.4l2.2 6.2h5.9L22.2 10h-6.4Zm-.8 16.9L19 15.6l4 11.3h-8Z"
      />
    </svg>
  );
}

function GmailIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path fill="#4caf50" d="M45 16.2l-5 2.75-5 4.75L35 40h7c1.657 0 3-1.343 3-3V16.2z" />
      <path fill="#1e88e5" d="M3 16.2l3.614 1.71L13 23.7V40H6c-1.657 0-3-1.343-3-3V16.2z" />
      <polygon fill="#e53935" points="35,11.2 24,19.45 13,11.2 12,17 13,23.7 24,31.95 35,23.7 36,17" />
      <path fill="#c62828" d="M3 12.298V16.2l10 7.5V11.2L9.876 8.859C9.132 8.301 8.228 8 7.298 8 4.924 8 3 9.924 3 12.298z" />
      <path fill="#fbc02d" d="M45 12.298V16.2l-10 7.5V11.2l3.124-2.341C38.868 8.301 39.772 8 40.702 8 43.076 8 45 9.924 45 12.298z" />
    </svg>
  );
}

function LinearIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        fill="#5E6AD2"
        d="M2.886 4.18A11.982 11.982 0 0 1 11.838 0L2.886 8.952V4.18ZM.21 9.683 9.683.21a11.987 11.987 0 0 0-3.092 1.149L1.36 6.59A11.987 11.987 0 0 0 .21 9.683Zm.045 4.052L13.735.255a12.018 12.018 0 0 0-1.79.097L.352 11.945a12.018 12.018 0 0 0-.097 1.79Zm.836 3.456L17.243 1.09a12.06 12.06 0 0 0-1.371-.71L.38 15.872c.18.484.418.943.71 1.371Zm2.04 2.51L19.728 3.66a12.066 12.066 0 0 0-1.04-1.184L2.475 18.69c.367.385.763.732 1.184 1.04Zm3.158 1.86L21.96 6.752a11.918 11.918 0 0 0-.72-1.398L5.354 21.24c.443.275.911.516 1.398.72ZM12 24c6.627 0 12-5.373 12-12 0-.34-.014-.675-.041-1.008L11.008 23.96c.333.027.668.041 1.008.041Z"
      />
    </svg>
  );
}

function PylonIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" {...props}>
      <rect width="32" height="32" rx="8" fill="#6D4AFF" />
      <path
        fill="none"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        d="M16 7a9 9 0 1 0 9 9"
      />
      <circle cx="16" cy="16" r="3.2" fill="#fff" />
    </svg>
  );
}

function SlackIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 122.8 122.8" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        fill="#36C5F0"
        d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z"
      />
      <path
        fill="#2EB67D"
        d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z"
      />
      <path
        fill="#ECB22E"
        d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z"
      />
      <path
        fill="#E01E5A"
        d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z"
      />
    </svg>
  );
}

function ClaudeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 600 600" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        fill="#D97757"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M525 273.7h75v77.6h-75V427h-37.2v73H450v-73h-37.2v73H375v-73H225v73h-37.8v-73H150v73h-37.8v-73H75v-75.7H0v-77.6h75V125h450zm-375 0h37.2v-71.1H150zm262.8 0H450v-71.1h-37.2z"
      />
    </svg>
  );
}

function CodexIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" {...props}>
      <defs>
        <linearGradient id="codex-cloud" x1="12" x2="36" y1="7" y2="43" gradientUnits="userSpaceOnUse">
          <stop stopColor="#D7DEFF" />
          <stop offset=".42" stopColor="#8B8CFF" />
          <stop offset="1" stopColor="#124BFF" />
        </linearGradient>
      </defs>
      <path
        fill="url(#codex-cloud)"
        d="M15.7 39.5c-6.3 0-11.2-4.3-11.2-10.3 0-5 3.4-9 8-10.1C14 12.2 20 7.5 27 8.6c5 .8 8.8 4 10.4 8.4 4.3.9 7.1 4.8 7.1 9.3 0 5.7-4.7 10.2-10.6 10.2H15.7Z"
      />
      <path
        fill="none"
        stroke="#fff"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="3.4"
        d="m18.6 21.2 4.2 4.2-4.2 4.2M28.4 29.6h6"
      />
    </svg>
  );
}

function BedrockAgentCoreIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" {...props}>
      <defs>
        <linearGradient id="agentcore-bg" x1="4" x2="44" y1="44" y2="4" gradientUnits="userSpaceOnUse">
          <stop stopColor="#3B1D8F" />
          <stop offset=".48" stopColor="#7C3AED" />
          <stop offset="1" stopColor="#9B5CFF" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="9" fill="url(#agentcore-bg)" />
      <path
        fill="none"
        stroke="#fff"
        strokeLinejoin="round"
        strokeWidth="2.8"
        d="m17 10 8-4.5 8 4.5v10l-5 3 5 3v10l-8 4.5-8-4.5v-10l5-3-5-3z"
      />
      <path
        fill="none"
        stroke="#fff"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.8"
        d="M25 10v10l-4 2.5M25 40V30l4-2.5"
      />
      <path
        fill="none"
        stroke="#fff"
        strokeLinejoin="round"
        strokeWidth="2.8"
        d="m36.5 16.5 3.1 6.4 6.4 3.1-6.4 3.1-3.1 6.4-3.1-6.4-6.4-3.1 6.4-3.1z"
      />
    </svg>
  );
}

function CursorIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" {...props}>
      <rect width="48" height="48" rx="10" fill="#000" />
      <path
        fill="#fff"
        d="M23.2 8.9a3.2 3.2 0 0 1 3.2 0l14.9 8.7a3.2 3.2 0 0 1 1.6 2.8v17.2a3.2 3.2 0 0 1-1.6 2.8l-14.9 8.7a3.2 3.2 0 0 1-3.2 0L8.7 40.4a3.2 3.2 0 0 1-1.6-2.8V20.4a3.2 3.2 0 0 1 1.6-2.8l14.5-8.7Z"
      />
      <path
        fill="#000"
        d="M12.2 19.4h23.4a.8.8 0 0 1 .7 1.2L25.1 40.1a.8.8 0 0 1-1.5-.1l-3.9-11.4a2 2 0 0 0-.8-1.1L11.8 21a.8.8 0 0 1 .4-1.5Z"
      />
    </svg>
  );
}

function GeminiIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" {...props}>
      <rect width="48" height="48" rx="10" fill="#0B57D0" />
      <path
        fill="#fff"
        d="M24 7.5c1.7 7.9 6.6 12.8 16.5 16.5C30.6 27.7 25.7 32.6 24 40.5 22.3 32.6 17.4 27.7 7.5 24 17.4 20.3 22.3 15.4 24 7.5Z"
      />
      <path
        fill="#AECBFA"
        d="M33.8 6.8c.7 3.2 2.7 5.2 6.7 6.7-4 1.5-6 3.5-6.7 6.7-.7-3.2-2.7-5.2-6.7-6.7 4-1.5 6-3.5 6.7-6.7Z"
      />
    </svg>
  );
}

function OpenCodeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" {...props}>
      <rect width="48" height="48" rx="10" fill="#171717" />
      <path
        fill="#fff"
        d="M14.6 31.6 7 24l7.6-7.6 2.8 2.8-4.8 4.8 4.8 4.8-2.8 2.8Zm18.8 0-2.8-2.8 4.8-4.8-4.8-4.8 2.8-2.8L41 24l-7.6 7.6ZM21.1 35h-4.2l10-22h4.2l-10 22Z"
      />
    </svg>
  );
}

function FallbackIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
      <path d="M14 7h5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-5M10 7H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h5M8 12h8" />
    </svg>
  );
}

const ICONS: Record<string, (p: SVGProps<SVGSVGElement>) => ReactNode> = {
  anthropic: AnthropicIcon,
  bedrock_agent_core: BedrockAgentCoreIcon,
  claude: ClaudeIcon,
  codex: CodexIcon,
  cursor: CursorIcon,
  gemini: GeminiIcon,
  gemini_antigravity: GeminiIcon,
  gmail: GmailIcon,
  linear: LinearIcon,
  opencode: OpenCodeIcon,
  pylon: PylonIcon,
  slack: SlackIcon,
};

export function BrandIcon({
  id,
  className,
}: {
  id: string;
  className?: string;
}) {
  const Icon = ICONS[id] ?? FallbackIcon;
  return <Icon className={className} />;
}
