#!/usr/bin/env python3
"""
Michigan Unclaimed Property research organizer, for use with OMNI-RECON.

Reads input.csv, writes research packets and tracking.csv. Does not scrape
and does not send anything over the network.

Usage:
  python3 organizer.py
  python3 organizer.py --input path/to/input.csv --out .
  python3 organizer.py --template
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
import urllib.parse
from datetime import datetime
from pathlib import Path

TREASURY_SEARCH_URL = "https://unclaimedproperty.michigan.gov/app/claim-search"

SUFFIX = re.compile(
    r"^(jr\.?|sr\.?|ii|iii|iv|inc\.?|llc|ltd\.?|co\.?|corp\.?|l\.?l\.?c\.?)$",
    re.I,
)

SAMPLE_ROWS = [
    {
        "name": "Jane Doe",
        "city": "Warren",
        "company": "Merit Manufacturing",
        "notes": "Plant renovation in 2026",
    },
    {
        "name": "Smith, John",
        "city": "Madison Heights",
        "company": "Acme, Inc.",
        "notes": "Quoted company name and Last, First name",
    },
    {
        "name": "Kevin Miles",
        "city": "Reed City",
        "company": "SBR TECH",
        "notes": "",
    },
]


def enc(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def slug(value: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", value.strip().lower())
    return value.strip("-")


def normalize_person_name(raw: str) -> tuple[str, str]:
    original = re.sub(r"\s+", " ", raw).strip()
    if "," in original:
        parts = [p.strip() for p in original.split(",", 1)]
        if len(parts) == 2 and parts[0] and parts[1] and not SUFFIX.match(parts[1]):
            return original, f"{parts[1]} {parts[0]}"
    return original, original


def fps_city_slug(city: str) -> str:
    value = slug(city)
    if not value:
        return ""
    if value.endswith("-michigan"):
        value = value[: -len("-michigan")] + "-mi"
    if not value.endswith("-mi"):
        value = f"{value}-mi"
    return value


def split_name(name: str) -> tuple[str, str]:
    parts = [p for p in name.split(" ") if p]
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], parts[-1]


def google(query: str) -> str:
    return f"https://www.google.com/search?q={enc(query)}"


def make_links(name: str, city: str) -> list[tuple[str, str]]:
    city_state = f"{city}, Michigan" if city else "Michigan"
    first, last = split_name(name)
    name_slug = slug(name)
    city_slug = fps_city_slug(city)
    who = f'"{name}" "{city_state}"' if city else f'"{name}"'
    links: list[tuple[str, str]] = [
        ("Michigan Treasury unclaimed property", TREASURY_SEARCH_URL),
        (
            "TruePeopleSearch",
            f"https://www.truepeoplesearch.com/results?name={enc(name)}&citystatezip={enc(city)}",
        ),
    ]
    if name_slug:
        fps = (
            f"https://www.fastpeoplesearch.com/name/{name_slug}_{city_slug}"
            if city_slug
            else f"https://www.fastpeoplesearch.com/name/{name_slug}"
        )
        links.append(("FastPeopleSearch", fps))
    links.extend(
        [
            (
                "Google (name + city + Michigan)",
                google(f"{name} {city} Michigan" if city else f"{name} Michigan"),
            ),
            (
                "Google obituaries",
                google(
                    f"{name} obituary {city} Michigan"
                    if city
                    else f"{name} obituary Michigan"
                ),
            ),
            ("Michiganology", "https://michiganology.org/"),
            ("FamilySearch", "https://www.familysearch.org/search/"),
        ]
    )
    if last:
        params = urllib.parse.urlencode(
            {"firstname": first, "lastname": last, "location": city_state}
        )
        links.append(
            ("Find A Grave", f"https://www.findagrave.com/memorial/search?{params}")
        )
    else:
        links.append(
            (
                "Find A Grave",
                "https://www.findagrave.com/memorial/search?"
                f"firstname=&lastname={enc(name)}&location={enc(city_state)}",
            )
        )
    links.extend(
        [
            (
                "Assessor / register of deeds",
                google(
                    f'{name} "{city_state}" (assessor OR "register of deeds" OR GIS OR parcel OR "tax roll")'
                ),
            ),
            ("Google exact name", google(who)),
            ("CourtListener", f"https://www.courtlistener.com/?q={enc(name)}&type=p"),
            (
                "Judyrecords",
                "https://www.judyrecords.com/record?"
                f"q={enc(' '.join(p for p in (name, city) if p))}",
            ),
            ("OpenCorporates", f"https://opencorporates.com/officers?q={enc(name)}"),
            (
                "FamilySearch records",
                "https://www.familysearch.org/search/record/results?"
                f"q.givenName={enc(first)}&q.surname={enc(last or name)}"
                + (f"&q.anyPlace={enc(city_state)}" if city else ""),
            ),
            ("LinkedIn via Google", google(f"site:linkedin.com/in {who}")),
            (
                "VoterRecords (coverage varies)",
                f"https://voterrecords.com/voters/{name_slug or 'search'}/1",
            ),
        ]
    )
    if city:
        links.extend(
            [
                (
                    "Google Maps",
                    f"https://www.google.com/maps/search/?api=1&query={enc(city_state)}",
                ),
                (
                    "OpenStreetMap",
                    f"https://www.openstreetmap.org/search?query={enc(city_state)}",
                ),
            ]
        )
    return links


def packet_filename(record_id: int, normalized: str) -> str:
    slug_name = re.sub(r"[^\w.-]+", "", normalized.replace(" ", "_"))[:30] or "record"
    return f"{record_id:04d}_{slug_name}.txt"


def write_packet(path: Path, record: dict, links: list[tuple[str, str]]) -> None:
    lines = [
        f"Record {record['id']}",
        f"Name: {record['name']}",
    ]
    if record["name_normalized"] != record["name"]:
        lines.append(f"Normalized name: {record['name_normalized']}")
    lines.extend(
        [
            f"City: {record['city']}",
            f"Company: {record['company']}",
            f"Notes: {record['notes']}",
            "",
            "Search links:",
        ]
    )
    for label, url in links:
        lines.append(f"{label}: {url}")
    lines.extend(
        [
            "",
            "County property search tip: look up the city or county assessor, GIS portal, or register of deeds, then search by owner name.",
            "The official Michigan Treasury unclaimed property search is a form. The link opens the search page; paste the name there. It does not accept a pre-filled name.",
            "",
        ]
    )
    path.write_text("\n".join(lines), encoding="utf-8")


def write_template(path: Path) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["name", "city", "company", "notes"])
        writer.writeheader()
        writer.writerows(SAMPLE_ROWS)


def cell(row: dict, *keys: str) -> str:
    lower = {str(k).strip().lower().replace(" ", "_"): v for k, v in row.items()}
    for key in keys:
        value = lower.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build Michigan unclaimed-property research packets and a tracking sheet. Does not scrape."
    )
    parser.add_argument("--input", default="input.csv", help="CSV with name,city,company,notes")
    parser.add_argument("--out", default=".", help="Output directory")
    parser.add_argument(
        "--template",
        action="store_true",
        help="Write a sample input.csv in the output directory and exit",
    )
    args = parser.parse_args(argv)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.template:
        dest = out_dir / "input.csv"
        write_template(dest)
        print(f"Wrote sample template to {dest}")
        return 0

    source = Path(args.input)
    if not source.exists():
        print(
            f"Create {source} with columns: name,city,company,notes "
            "(or run with --template). Quoted fields and Last, First names are supported.",
            file=sys.stderr,
        )
        return 1

    packet_dir = out_dir / "research_packets"
    packet_dir.mkdir(exist_ok=True)

    rows: list[dict] = []
    skipped = 0
    with source.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            print("The CSV has no header row.", file=sys.stderr)
            return 1
        for raw in reader:
            name = cell(raw, "name", "owner", "owner_name", "full_name")
            if not name:
                skipped += 1
                continue
            original, normalized = normalize_person_name(name)
            record_id = len(rows) + 1
            city = cell(raw, "city", "city_state", "location", "loc")
            record = {
                "id": record_id,
                "name": original,
                "name_normalized": normalized,
                "city": city,
                "company": cell(raw, "company", "employer", "business", "holder"),
                "notes": cell(raw, "notes", "note", "comments", "comment"),
                "status": "new",
                "possible_address": "",
                "phone": "",
                "deceased": "",
                "heirs_notes": "",
                "packet": packet_filename(record_id, normalized),
                "created": datetime.now().isoformat(timespec="seconds"),
            }
            links = make_links(normalized, city)
            write_packet(packet_dir / record["packet"], record, links)
            rows.append(record)

    if not rows:
        print("No valid rows (blank names are skipped).")
        return 1

    tracking = out_dir / "tracking.csv"
    fieldnames = [
        "id",
        "name",
        "city",
        "company",
        "status",
        "possible_address",
        "phone",
        "deceased",
        "heirs_notes",
        "packet",
        "created",
    ]
    with tracking.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)

    message = f"Wrote {len(rows)} research packets to {packet_dir}/ and {tracking}"
    if skipped:
        message += f" (skipped {skipped} blank name row{'s' if skipped != 1 else ''})"
    print(message)
    print(f"Official Treasury search: {TREASURY_SEARCH_URL}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
