const KNOWN_UWP_FRIENDLY_NAMES: Record<string, string> = {
  'microsoft.windowsnotepad': 'Notepad',
  'microsoft.notepad': 'Notepad',
  'microsoft.windowscalculator': 'Calculator',
  'microsoft.windowsterminal': 'Terminal',
  'microsoft.windowsalarms': 'Alarms & Clock',
  'microsoft.windowscamera': 'Camera',
  'microsoft.windowsmaps': 'Maps',
  'microsoft.windowssoundrecorder': 'Sound Recorder',
  'microsoft.windowsfeedbackhub': 'Feedback Hub',
  'microsoft.windowsstore': 'Microsoft Store',
  'microsoft.zunemusic': 'Media Player',
  'microsoft.zunevideo': 'Movies & TV',
  'microsoft.windowsphotos': 'Photos',
  'microsoft.windowscommunicationsapps': 'Mail & Calendar',
  'microsoft.people': 'People',
  'microsoft.gethelp': 'Get Help',
  'microsoft.getstarted': 'Tips',
  'microsoft.microsoftstickynotes': 'Sticky Notes',
  'microsoft.stickynotes': 'Sticky Notes',
  'microsoft.screensketch': 'Snipping Tool',
  'microsoft.snippingtool': 'Snipping Tool',
  'microsoft.paint': 'Paint',
  'microsoft.mspaint': 'Paint',
  'microsoft.microsoftedge': 'Microsoft Edge',
  'microsoft.microsoftedge.stable': 'Microsoft Edge',
  'microsoft.todos': 'Microsoft To Do',
  'microsoft.microsofttodo': 'Microsoft To Do',
  'microsoft.office.onenote': 'OneNote',
  'microsoft.onenote': 'OneNote',
  'microsoft.office.word': 'Word',
  'microsoft.office.excel': 'Excel',
  'microsoft.office.powerpoint': 'PowerPoint',
  'microsoft.office.outlook': 'Outlook',
  'microsoft.outlookforwindows': 'Outlook',
  'microsoft.office.access': 'Access',
  'microsoft.microsoftofficehub': 'Office',
  'microsoft.officehub': 'Office',
  'microsoft.microsoftoffice': 'Office',
  'microsoft.whiteboard': 'Whiteboard',
  'microsoft.microsoftwhiteboard': 'Whiteboard',
  'microsoft.teams': 'Teams',
  'microsoftteams': 'Teams',
  'msteams': 'Teams',
  'microsoft.bingweather': 'Weather',
  'microsoft.bingnews': 'News',
  'microsoft.bingsports': 'Sports',
  'microsoft.bingfinance': 'Finance',
  'microsoft.bingmaps': 'Maps',
  'microsoft.bingsearch': 'Bing Search',
  'microsoft.bingtranslator': 'Translator',
  'microsoft.xboxapp': 'Xbox',
  'microsoft.xbox.tcui': 'Xbox',
  'microsoft.gamingapp': 'Xbox',
  'microsoft.microsoftjournal': 'Journal',
  'microsoft.clipchamp': 'Clipchamp',
  'microsoft.heifimageextension': 'HEIF Image Extensions',
  'microsoft.webpimageextension': 'WebP Image Extensions',
  'microsoft.rawimageextension': 'Raw Image Extensions',
  'microsoft.hevcimagextension': 'HEVC Video Extensions',
  'microsoft.webmediaextensions': 'Web Media Extensions',
  'microsoft.vp9videoextensions': 'VP9 Video Extensions',
  'microsoft.av1videoextension': 'AV1 Video Extensions',
  'microsoft.mpeghevcvideextension': 'HEVC Video Extensions',
  'microsoft.powerapps': 'Power Apps',
  'microsoft.powerbi': 'Power BI',
  'microsoft.powerautomate': 'Power Automate',
  'microsoft.skypeapp': 'Skype',
  'microsoft.yourphone': 'Phone Link',
  'microsoft.windowsphone': 'Phone Link',
  'microsoft.accounts': 'Accounts',
  'microsoft.mixer': 'Mixer',
  'microsoft.mixedreality.portal': 'Mixed Reality Portal',
  'microsoft.549981c3f5f10': 'Cortana',
  'microsoft.cortana': 'Cortana',
  'microsoft.msixpackagingtool': 'MSIX Packaging Tool',
  'microsoft.devhome': 'Dev Home',
  'microsoft.windowsdevhome': 'Dev Home',
  'spotify.spotifymusic': 'Spotify',
  'spotifyab.spotifymusic': 'Spotify',
  'disney.disneyplus': 'Disney+',
  'netflix': 'Netflix',
  'amazon.com.amazon': 'Amazon',
  'telegram.telegramdesktop': 'Telegram',
  'whatsapp': 'WhatsApp',
  '9nksqgp7f2nh': 'WhatsApp',
  'facebook.facebook': 'Facebook',
  'facebook.instagram': 'Instagram',
  'twitter.twitter': 'Twitter',
  'tiktok.tiktok': 'TikTok',
  'zoom.zoom': 'Zoom',
  'discord.discord': 'Discord',
  'slack.slack': 'Slack',
  'notion.notion': 'Notion',
  'figma.figma': 'Figma',
  'canva.canva': 'Canva',
}

export function friendlyNameFromPackage(packageIdOrFamily: string): string | null {
  const lower = packageIdOrFamily.toLowerCase()
  const base = lower.split('_')[0]
  if (KNOWN_UWP_FRIENDLY_NAMES[base]) return KNOWN_UWP_FRIENDLY_NAMES[base]
  for (const [key, name] of Object.entries(KNOWN_UWP_FRIENDLY_NAMES)) {
    if (base.includes(key) || key.includes(base)) return name
  }
  const parts = base.split('.')
  if (parts.length >= 2) {
    const lastPart = parts[parts.length - 1]
    const cleaned = lastPart
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/^windows/i, '')
      .trim()
    if (cleaned.length > 1) return cleaned
  }
  return null
}

export function cleanupAppDisplayName(name: string): string {
  if (!name) return name
  if (name.startsWith('@{') && name.includes('}')) {
    const inner = name.slice(2, name.indexOf('}'))
    const withoutResource = inner.split('?')[0]
    const friendly = friendlyNameFromPackage(withoutResource)
    if (friendly) return friendly
  }
  const friendly = friendlyNameFromPackage(name)
  if (friendly) return friendly
  return name
}
