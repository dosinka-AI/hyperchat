HYPERION — your own chat server
══════════════════════════════

START HERE
  1. unzip this folder anywhere (a usb stick folder, your hard drive…)
  2. open a terminal in this folder
  3. run:   ./hyperion
  4. pick 1 (it installs everything — internet needed, ~5 minutes)
  5. pick 1 again to start
  6. open the address it shows you in a browser
  7. register — the FIRST account you make is the owner/admin

EVERY DAY
  ./hyperion        → the menu
    1 start · 2 stop · 3 status · 4 logs · 5 backup · 6 restore
    7 tunnel (share over the internet) · 8 how this works

  unzip a newer zip over the folder and pick 1 — it notices the app
  changed and rebuilds by itself (your accounts + database stay put).

  the checks the manager runs (is the page answering, is chat alive)
  go through bun itself — nothing depends on curl being installed.

  after a reboot it's three steps:
    1 (start)  →  7 (tunnel)  →  paste the new address into your txt

HOW PEOPLE FIND YOUR SERVER
  same wifi:    anyone on your network opens http://<this-machine>:3000

  over the internet:  option 7 starts a tunnel (cloudflared — it gets
    downloaded the first time). it prints a temporary https address
    like https://random-words.trycloudflare.com

  the txt file is YOUR job, by hand:
    . put that address in a file called server.txt on github
      (first line = the address, nothing else needed)
    . every hyperion client reads that txt to find your server
    . when the tunnel address changes (it does, every restart),
      edit the txt on github — every client follows. nothing is
      ever reinstalled on anyone's machine.

  important: this server never reads or needs that txt. it runs
  completely on its own — the txt is purely between you and your
  clients. (the admin panel has an optional "client discovery" check
  if you ever want the website to confirm what your txt currently
  says — off by default, pure convenience.)

  a ready-made client page is included: public/client/index.html.
  upload that one file to github pages (or any static host) once and
  share THAT link — it reads your server.txt live and takes people
  straight to the current address, forever.

BIG STORAGE (the 4TB drive)
  the app keeps its files in folders inside itself by default. to run
  them off a big external drive:
    1. mount the drive (say at /mnt/hyperdrive)
    2. open .env and point both storage vars at folders on the mount:
         VAULT_DIR=/mnt/hyperdrive/vault
         UPLOAD_DIR=/mnt/hyperdrive/uploads
    3. restart the server (option 2, then option 1)
  new files land on the drive immediately — no migration step, nothing
  else to configure. old files keep working only while the old folder
  still exists: to MOVE them, stop the server, copy the old db/vault
  folder to the drive (e.g. to /mnt/hyperdrive/vault) and set VAULT_DIR
  to that same path before starting again.
  two dials in the same .env section:
    VAULT_BUDGET_BYTES (default 400 GiB) — how full the vault may get.
      as it fills, file lifetimes shrink automatically (floor: 10
      minutes) so a busy chat can never wedge the disk.
    VAULT_DAILY_USER_BYTES (default 8 GiB) — one account's daily upload
      budget, a failsafe against a runaway sender.

GOOD TO KNOW
  . the database is ONE file: db/custom.db — copy it = full backup
    (option 5 does this for you, keeps the last 14)
  . this zip contains zero accounts, zero messages, zero files —
    a brand new empty server that is entirely yours
  . to fully uninstall: stop the server, delete the folder. done.
