// tether-port-mirror: keeps a copy of Chrome's DevToolsActivePort where Tether can read it.
//
// Newer Chrome on macOS keeps its data folder (~/Library/Application Support/Google/Chrome)
// readable only by Chrome and by programs you allow, so other programs can't take your cookies.
// The broker and the connect watch need one small file from it: DevToolsActivePort, which
// holds the debugging port and the browser's WebSocket path (no cookies, no passwords).
//
// Instead of giving node (and every node script) access to all of Chrome's data, you give it to
// this program only: System Settings > Privacy & Security > Full Disk Access. Every 2 seconds it
// reads that one file and keeps ~/.tether/chrome/DevToolsActivePort the same (mode 0600). When
// Chrome's file is gone (Chrome closed, remote debugging off), the copy is removed too.
// It reads nothing else, writes nothing else and never talks to the network.
//
// Built by scripts/port-mirror-setup.sh:  clang -O2 -Wall -o ~/.tether/bin/tether-port-mirror mac/port-mirror.c

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static void say(const char *what, const char *path) {
  char stamp[32];
  time_t now = time(NULL);
  strftime(stamp, sizeof stamp, "%Y-%m-%d %H:%M:%S", localtime(&now));
  fprintf(stderr, "%s  %s %s\n", stamp, what, path);
}

int main(int argc, char **argv) {
  const char *home = getenv("HOME");
  if (!home || !*home) return 1;
  int once = argc > 1 && strcmp(argv[1], "--once") == 0;  // one pass, for tests and --status

  char src[2048], base[2048], dir[2100], dst[2200], tmp[2300];
  snprintf(src, sizeof src, "%s/Library/Application Support/Google/Chrome/DevToolsActivePort", home);
  const char *tether = getenv("TETHER_HOME");
  if (tether && *tether) snprintf(base, sizeof base, "%s", tether);
  else snprintf(base, sizeof base, "%s/.tether", home);
  snprintf(dir, sizeof dir, "%s/chrome", base);
  snprintf(dst, sizeof dst, "%s/DevToolsActivePort", dir);
  snprintf(tmp, sizeof tmp, "%s.tmp", dst);
  mkdir(base, 0700);  // both may exist already
  mkdir(dir, 0700);

  char last[4096];
  ssize_t lastn = -1;  // -1: nothing known yet, 0: no file
  int warned = 0;
  for (;;) {
    char buf[4096];
    ssize_t n = -1;
    int err = 0;
    int fd = open(src, O_RDONLY);
    if (fd < 0) err = errno;
    else { n = read(fd, buf, sizeof buf); if (n < 0) err = errno; close(fd); }

    if (n > 0 && n < (ssize_t)sizeof buf) {
      warned = 0;
      if (n != lastn || memcmp(buf, last, (size_t)n) != 0) {
        int out = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0600);
        if (out >= 0) {
          int ok = write(out, buf, (size_t)n) == n;
          close(out);
          if (ok && rename(tmp, dst) == 0) { memcpy(last, buf, (size_t)n); lastn = n; say("copied", src); }
          else unlink(tmp);
        }
      }
    } else if (err == ENOENT) {
      if (lastn != 0) { if (unlink(dst) == 0) say("removed (Chrome's file is gone)", dst); lastn = 0; }
    } else if (err == EPERM || err == EACCES) {
      if (!warned) { say("no permission to read (give this program Full Disk Access):", src); warned = 1; }
    }
    if (once) return (n > 0 || err == ENOENT) ? 0 : 2;
    sleep(2);
  }
}
