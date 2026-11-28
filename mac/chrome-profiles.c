// tether-chrome-profiles: tells Tether which Chrome profiles you have, and which of them
// has the Tether extension, so every Claude session can be told where its tabs open.
//
// Newer Chrome on macOS keeps its data folder (~/Library/Application Support/Google/Chrome)
// readable only by Chrome and by programs you allow. Like tether-port-mirror, this small
// program gets that permission (System Settings > Privacy & Security > Full Disk Access)
// instead of node. Every 30 seconds it reads:
//   - "Local State", and keeps only its list of profiles ("info_cache": each profile's
//     folder, name and the Google account it's signed in to, nothing else from the file);
//   - each profile's "Preferences" and "Secure Preferences", only to see whether they
//     mention the Tether extension's ID (the IDs are in ~/.tether/chrome/tether-ids,
//     written by the broker).
// It writes ~/.tether/chrome/profiles.json (mode 0600) when that changes:
//   {"info_cache": { ...as in Local State... }, "tether": ["Profile 2"]}
// It writes nothing else and never talks to the network.
//
// Built by scripts/port-mirror-setup.sh:  clang -O2 -Wall -o ~/.tether/bin/tether-chrome-profiles mac/chrome-profiles.c
// TETHER_HOME and TETHER_CHROME_DIR change where it reads and writes (the tests use them).

#include <dirent.h>
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

// The whole file, NUL-terminated; NULL with errno set when it can't be read.
static char *slurp(const char *path, size_t max, size_t *len) {
  int fd = open(path, O_RDONLY);
  if (fd < 0) return NULL;
  struct stat st;
  if (fstat(fd, &st) != 0 || st.st_size < 0 || (size_t)st.st_size > max) { close(fd); errno = EFBIG; return NULL; }
  char *buf = malloc((size_t)st.st_size + 1);
  if (!buf) { close(fd); return NULL; }
  size_t got = 0;
  while (got < (size_t)st.st_size) {
    ssize_t n = read(fd, buf + got, (size_t)st.st_size - got);
    if (n <= 0) break;
    got += (size_t)n;
  }
  close(fd);
  buf[got] = 0;
  if (len) *len = got;
  return buf;
}

// The JSON object that follows "key": in text, as a span (start, length), or 0.
static int object_after(const char *text, const char *key, const char **start, size_t *span) {
  char needle[64];
  snprintf(needle, sizeof needle, "\"%s\"", key);
  const char *p = strstr(text, needle);
  if (!p) return 0;
  p += strlen(needle);
  while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
  if (*p++ != ':') return 0;
  while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
  if (*p != '{') return 0;
  const char *s = p;
  int depth = 0, in_string = 0;
  for (; *p; p++) {
    if (in_string) {
      if (*p == '\\' && p[1]) p++;
      else if (*p == '"') in_string = 0;
    } else if (*p == '"') in_string = 1;
    else if (*p == '{') depth++;
    else if (*p == '}' && --depth == 0) { *start = s; *span = (size_t)(p - s + 1); return 1; }
  }
  return 0;
}

// A profile folder Chrome makes: "Default", "Profile 1", "Profile 2", ...
static int profile_folder(const char *name) {
  if (strcmp(name, "Default") == 0) return 1;
  if (strncmp(name, "Profile ", 8) != 0 || !name[8]) return 0;
  for (const char *c = name + 8; *c; c++) if (*c < '0' || *c > '9') return 0;
  return 1;
}

int main(int argc, char **argv) {
  const char *home = getenv("HOME");
  if (!home || !*home) return 1;
  int once = argc > 1 && strcmp(argv[1], "--once") == 0;

  char chrome[2048], base[2048], dir[2100], dst[2200], tmp[2300], ids_file[2200], state[2200];
  const char *c = getenv("TETHER_CHROME_DIR");
  if (c && *c) snprintf(chrome, sizeof chrome, "%s", c);
  else snprintf(chrome, sizeof chrome, "%s/Library/Application Support/Google/Chrome", home);
  const char *t = getenv("TETHER_HOME");
  if (t && *t) snprintf(base, sizeof base, "%s", t); else snprintf(base, sizeof base, "%s/.tether", home);
  snprintf(dir, sizeof dir, "%s/chrome", base);
  snprintf(dst, sizeof dst, "%s/profiles.json", dir);
  snprintf(tmp, sizeof tmp, "%s.tmp", dst);
  snprintf(ids_file, sizeof ids_file, "%s/tether-ids", dir);
  snprintf(state, sizeof state, "%s/Local State", chrome);
  mkdir(base, 0700);
  mkdir(dir, 0700);

  char *last = NULL;
  int warned = 0;
  for (;;) {
    int ok = 0;
    char *local = slurp(state, 64u << 20, NULL);
    if (!local) {
      if ((errno == EPERM || errno == EACCES) && !warned) { say("no permission to read (give this program Full Disk Access):", state); warned = 1; }
    } else {
      warned = 0;
      const char *cache = NULL;
      size_t cache_len = 0;
      if (!object_after(local, "info_cache", &cache, &cache_len)) { cache = "{}"; cache_len = 2; }

      // Tether's IDs: 32 letters a-p each, one per line.
      char ids[16][33];
      int nids = 0;
      char *idtext = slurp(ids_file, 1u << 16, NULL);
      for (char *line = idtext ? strtok(idtext, "\r\n") : NULL; line && nids < 16; line = strtok(NULL, "\r\n")) {
        if (strlen(line) != 32 || strspn(line, "abcdefghijklmnop") != 32) continue;
        memcpy(ids[nids++], line, 33);
      }
      free(idtext);

      // The profiles that mention one of them.
      size_t cap = 4096, used = 0;
      char *tether = malloc(cap);
      tether[0] = 0;
      DIR *d = nids ? opendir(chrome) : NULL;
      for (struct dirent *e = d ? readdir(d) : NULL; e; e = readdir(d)) {
        if (!profile_folder(e->d_name)) continue;
        int found = 0;
        const char *files[] = { "Secure Preferences", "Preferences" };
        for (int f = 0; f < 2 && !found; f++) {
          char p[4400];
          snprintf(p, sizeof p, "%s/%s/%s", chrome, e->d_name, files[f]);
          char *prefs = slurp(p, 256u << 20, NULL);
          for (int i = 0; prefs && i < nids && !found; i++) {
            char quoted[40];
            snprintf(quoted, sizeof quoted, "\"%s\"", ids[i]);
            if (strstr(prefs, quoted)) found = 1;
          }
          free(prefs);
        }
        if (found && used + strlen(e->d_name) + 8 < cap) {
          used += (size_t)snprintf(tether + used, cap - used, "%s\"%s\"", used ? "," : "", e->d_name);
        }
      }
      if (d) closedir(d);

      size_t outlen = cache_len + used + 64;
      char *out = malloc(outlen);
      int n = snprintf(out, outlen, "{\"info_cache\":%.*s,\"tether\":[%s]}\n", (int)cache_len, cache, tether);
      free(tether);
      free(local);
      if (n > 0 && (!last || strcmp(last, out) != 0)) {
        int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0600);
        if (fd >= 0) {
          int wrote = write(fd, out, (size_t)n) == n;
          close(fd);
          if (wrote && rename(tmp, dst) == 0) { free(last); last = out; out = NULL; say("wrote", dst); }
          else unlink(tmp);
        }
      }
      free(out);
      ok = 1;
    }
    if (once) return ok ? 0 : 2;
    sleep(30);
  }
}
