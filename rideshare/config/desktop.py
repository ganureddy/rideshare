"""Desk app icon configuration for the Rideshare app.

The Workspace JSON files (added per phase) drive the actual nav cards.
This file only contributes the entry on the Frappe Apps screen.
"""

from __future__ import annotations

from frappe import _


def get_data():
	return [
		{
			"module_name": "Rideshare",
			"category": "Modules",
			"label": _("Rideshare"),
			"color": "#00aff5",
			"icon": "octicon octicon-rocket",
			"type": "module",
			"description": _(
				"BlaBlaCar-style intercity carpooling marketplace."
			),
		},
	]
