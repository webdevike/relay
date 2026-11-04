# relay-mcp smoke transcript

Hidden test instance (temp config), agent RELAY_ASSISTANT=nova.

```
tools/list: 54 tools (relay_status, state_read, layout_read, window_screenshot, app_quit, update_offer, page_open, tab_focus, tab_close, tab_open, pane_split, pane_close, pane_move, pane_resize, pane_focus, pane_zoom, chat_open, chat_new, chat_start, files_open, browser_open, browser_focusTab, browser_closeTab, ecard_switch, testbench_open, context_open, context_read, context_pin, context_unpin, toast_show, shortcut_run, artifacts_list, artifacts_add, artifacts_pin, artifacts_unpin, artifacts_tab_add, artifacts_tab_update, artifacts_tab_remove, canvas_live, studio_generate, studio_list, studio_open, describe, pages_list, settings_get, settings_set, settings_undo, connections_list, connections_add, connections_remove, link, link_open, tour_highlight, tour_clear)

> describe {}
< {
  "text": "Page: New chat (relay://open/chat)\nTheme: Default, light\nPanes: p1 (focused): New chat; p2: Browser [Browser, Files]\nWindow: in front\nControls: Assistants [nav-assistants], Chat [nav-chat], Canvas [nav-canvas], Rooms [nav-rooms], Studio [nav-studio], Reviews [nav-reviews], Test Bench [nav-test-bench], Jobs 1 [nav-jobs], Habits [nav-habits], Meetings [nav-meetings], Dashboards [sidebar-dashboards-head], Overview [nav-dashboard], Setting [nav-setting], Back [tab-back], Forward [tab-forward], Close tab [tab-close-0], New tab [tab-new], Hide sidebar [sidebar-toggle], Nothing running [context-button], Hide tool panes [panel-toggle], omp account [composer-account], Access mode [composer-access], Model [composer-model], Send message [composer-send], Close Browser [pane-tab-close-browser]",
  "page": {
    "key": "chat",
    "title": "New chat",
    "section": null,
    "chat": null,
    "canvas": null,
    "reviewItem": null,
    "link": "relay://open/chat"
  },
  "selected": {
    "theme": {
      "preset": "Default",
      "mode": "light"
    }
  },
  "panes": [
    {
      "pane": "p1",
      "focused": true,
      "front": "New chat",
      "tabs": [
        "New chat"
      ]
    },
    {
      "pane": "p2",
      "focused": false,
      "front": "Browser",
      "tabs": [
        "Browser",
        "Files"
      ]
    }
  ],
  "controls": [
    {
      "target": "nav-assistants",
      "label": "Assistants",
      "kind": "button"
    },
    {
      "target": "nav-chat",
      "label": "Chat",
      "kind": "button"
    },
    {
      "target": "nav-canvas",
  ...

> settings_get {"key":"theme.preset"}
< {
  "settings": [
    {
      "key": "theme.preset",
      "title": "Theme",
      "section": "Theme",
      "value": "default",
      "options": [
        "default (Default)",
        "ocean (Ocean)",
        "forest (Forest)",
        "violet (Violet)",
        "amber-minimal (Amber Minimal)",
        "bold-tech (Bold Tech)",
        "bubblegum (Bubblegum)",
        "attio (Attio)",
        "caffeine (Caffeine)"
      ],
      "link": "relay://open/settings/theme?setting=theme.preset"
    }
  ]
}

> settings_set {"key":"theme.preset","value":"Ocean"}
< {
  "key": "theme.preset",
  "value": "ocean",
  "previous": "default",
  "changed": true,
  "changeId": "c1",
  "target": "theme-preset-picker",
  "undo": "settings.undo {\"changeId\":\"c1\"}"
}

> window_screenshot {"path":"/Users/ike/Eva/work/relay-agent-access/proof/agent-access/1-theme-ocean-toast.png"}
< [image/png 74878 bytes]
saved /Users/ike/Eva/work/relay-agent-access/proof/agent-access/1-theme-ocean-toast.png

> settings_set {"key":"theme.mode","value":"dark"}
< {
  "key": "theme.mode",
  "value": "dark",
  "previous": "light",
  "changed": true,
  "changeId": "c2",
  "target": "theme-color-scheme",
  "undo": "settings.undo {\"changeId\":\"c2\"}"
}

> window_screenshot {"path":"/Users/ike/Eva/work/relay-agent-access/proof/agent-access/2-dark-toast.png"}
< [image/png 77702 bytes]
saved /Users/ike/Eva/work/relay-agent-access/proof/agent-access/2-dark-toast.png

> settings_get {"key":"theme.mode"}
< {
  "settings": [
    {
      "key": "theme.mode",
      "title": "Appearance",
      "section": "Theme",
      "value": "light",
      "options": [
        "light",
        "dark"
      ],
      "link": "relay://open/settings/theme?setting=theme.mode"
    }
  ]
}

> settings_undo {}
< {
  "undone": "c1",
  "key": "theme.preset",
  "value": "default"
}

> describe {}
< {
  "text": "Page: New chat (relay://open/chat)\nTheme: Default, light\nPanes: p1 (focused): New chat; p2: Browser [Browser, Files]\nWindow: in front\nControls: Assistants [nav-assistants], Chat [nav-chat], Canvas [nav-canvas], Rooms [nav-rooms], Studio [nav-studio], Reviews [nav-reviews], Test Bench [nav-test-bench], Jobs 1 [nav-jobs], Habits [nav-habits], Meetings [nav-meetings], Dashboards [sidebar-dashboards-head], Overview [nav-dashboard], Setting [nav-setting], Back [tab-back], Forward [tab-forward], Close tab [tab-close-0], New tab [tab-new], Hide sidebar [sidebar-toggle], Nothing running [context-button], Hide tool panes [panel-toggle], omp account [composer-account], Access mode [composer-access], Model [composer-model], Send message [composer-send], Close Browser [pane-tab-close-browser]",
  "page": {
    "key": "chat",
    "title": "New chat",
    "section": null,
    "chat": null,
    "canvas": null,
    "reviewItem": null,
    "link": "relay://open/chat"
  },
  "selected": {
    "theme": {
      "preset": "Default",
      "mode": "light"
    }
  },
  "panes": [
    {
      "pane": "p1",
      "focused": true,
      "front": "New chat",
      "tabs": [
        "New chat"
      ]
    },
    {
      "pane": "p2",
      "focused": false,
      "front": "Browser",
      "tabs": [
        "Browser",
        "Files"
      ]
    }
  ],
  "controls": [
    {
      "target": "nav-assistants",
      "label": "Assistants",
      "kind": "button"
    },
    {
      "target": "nav-chat",
      "label": "Chat",
      "kind": "button"
    },
    {
      "target": "nav-canvas",
  ...

> settings_set {"key":"theme.colors.dark.body","value":"blue"}
< ERROR error: invalid-params: [
  {
    "code": "custom",
    "path": [
      "value"
    ],
    "message": "theme.colors.dark.body: a #rrggbb color"
  }
]

> link {"connection":"github"}
< {
  "url": "relay://open/settings/connections?connect=github",
  "label": "Settings › Connections › GitHub",
  "markdown": "[Settings › Connections › GitHub](relay://open/settings/connections?connect=github)"
}

> link_open {"url":"relay://open/settings/connections?connect=github"}
< {
  "opened": "relay://open/settings/connections?connect=github",
  "target": "here"
}

> describe {}
< {
  "text": "Page: Settings: Connections (relay://open/settings/connections)\nTheme: Default, light\nPanes: p1 (focused): Settings: Connections; p2: Browser [Browser, Files]\nWindow: in front\nControls: Assistants [nav-assistants], Chat [nav-chat], Canvas [nav-canvas], Rooms [nav-rooms], Studio [nav-studio], Reviews [nav-reviews], Test Bench [nav-test-bench], Jobs 1 [nav-jobs], Habits [nav-habits], Meetings [nav-meetings], Dashboards [sidebar-dashboards-head], Overview [nav-dashboard], Setting [nav-setting], Back [tab-back], Forward [tab-forward], Close tab [tab-close-0], New tab [tab-new], Hide sidebar [sidebar-toggle], Nothing running [context-button], Hide tool panes [panel-toggle], Relay Host NOT CONNECTED No Relay Host connected Used by Assistants, the iPhone, [connection-relay-host], GitHub NOT CHECKED Not checked outside the live app Used by Reviews, pull reques [connection-github], Connect [connection-github-connect], Linear NOT CONNECTED No Linear API key Used by Reviews, ticket badges and Artifa [connection-linear], Linear API key [connection-linear-key]",
  "page": {
    "key": "settings",
    "title": "Settings: Connections",
    "section": "Connections",
    "chat": null,
    "canvas": null,
    "reviewItem": null,
    "link": "relay://open/settings/connections"
  },
  "selected": {
    "theme": {
      "preset": "Default",
      "mode": "light"
    }
  },
  "panes": [
    {
      "pane": "p1",
      "focused": true,
      "front": "Settings: Connections",
      "tabs": [
        "Settings: Connections"
      ]
    },
    {
      "pane": "p2",
      "focused": 
  ...

> window_screenshot {"path":"/Users/ike/Eva/work/relay-agent-access/proof/agent-access/3-connections-deep-link.png"}
< [image/png 137068 bytes]
saved /Users/ike/Eva/work/relay-agent-access/proof/agent-access/3-connections-deep-link.png

> connections_list {}
< {
  "connections": [
    {
      "id": "relay-host",
      "title": "Relay Host",
      "kind": "host",
      "usedBy": "Assistants, the iPhone, Studio and live canvas rooms",
      "link": "relay://open/settings/connections?connect=relay-host",
      "status": "not-connected",
      "account": null,
      "detail": "No Relay Host connected",
      "canAdd": true,
      "canRemove": false
    },
    {
      "id": "github",
      "title": "GitHub",
      "kind": "login",
      "usedBy": "Reviews, pull request status and Artifacts",
      "link": "relay://open/settings/connections?connect=github",
      "status": "unknown",
      "account": null,
      "detail": "Not checked outside the live app",
      "canAdd": true,
      "canRemove": false
    },
    {
      "id": "linear",
      "title": "Linear",
      "kind": "key",
      "usedBy": "Reviews, ticket badges and Artifacts status",
      "link": "relay://open/settings/connections?connect=linear",
      "status": "not-connected",
      "account": null,
      "detail": "No Linear API key",
      "canAdd": true,
      "canRemove": false
    },
    {
      "id": "slack",
      "title": "Slack",
      "kind": "connector",
      "usedBy": "Reviews (read through Claude's connector)",
      "link": "relay://open/settings/connections?connect=slack",
      "status": "unknown",
      "account": null,
      "detail": "Read through Claude's Slack connector (claude.ai > Settings > Connectors)",
      "canAdd": false,
      "canRemove": false
    },
    {
      "id": "anthropic",
      "title": "Claude (Anthropic)",
      "kind": "login"
  ...

> connections_add {"id":"github"}
< {
  "status": "needs-user",
  "id": "github",
  "link": "relay://open/settings/connections?connect=github",
  "step": "Click Connect on GitHub in Settings > Connections, then enter the code it shows on github.com."
}

> tour_highlight {"target":"nav-setting","title":"Theme","caption":"Colors, fonts and light or dark live here. Ask me to change them any time.","step":{"n":2,"of":4}}
< {
  "target": "nav-setting",
  "label": "Setting",
  "rect": {
    "x": 12,
    "y": 722,
    "width": 240,
    "height": 36
  }
}

> window_screenshot {"path":"/Users/ike/Eva/work/relay-agent-access/proof/agent-access/4-tour-highlight.png"}
< [image/png 147929 bytes]
saved /Users/ike/Eva/work/relay-agent-access/proof/agent-access/4-tour-highlight.png

> tour_clear {}
< {
  "cleared": true
}

```
