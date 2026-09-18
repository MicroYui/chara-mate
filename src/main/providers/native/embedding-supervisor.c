// Main owns this supervisor; kqueue joins llama-server on shutdown or parent exit.
// Verified against llama.cpp b10964 and Apple SDK 26.5 on 2026-09-15.
// Apple SDK 26.5 sys/event.h: EVFILT_PROC/NOTE_EXIT and EVFILT_SIGNAL.
// This helper owns only the passed socket pathname; it never removes model data.
#include <sys/event.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static int watch(int queue, uintptr_t id, int16_t filter, uint32_t flags) {
    struct kevent event;
    EV_SET(&event, id, filter, EV_ADD | EV_ONESHOT, flags, 0, NULL);
    return kevent(queue, &event, 1, NULL, 0, NULL);
}

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "usage: embedding-supervisor <owned-socket> <executable> [args...]\n");
        return 64;
    }
    const pid_t owner = getppid();
    const int queue = kqueue();
    if (queue < 0 || owner == 1 || watch(queue, (uintptr_t)owner, EVFILT_PROC, NOTE_EXIT) < 0) {
        perror("watch owner");
        return 70;
    }
    signal(SIGTERM, SIG_IGN);
    signal(SIGINT, SIG_IGN);
    if (watch(queue, SIGTERM, EVFILT_SIGNAL, 0) < 0 || watch(queue, SIGINT, EVFILT_SIGNAL, 0) < 0 || getppid() != owner) {
        fprintf(stderr, "owner exited during startup or signal registration failed\n");
        close(queue);
        return 70;
    }
    const pid_t child = fork();
    if (child < 0) { perror("fork"); close(queue); return 70; }
    if (child == 0) {
        close(queue);
        signal(SIGTERM, SIG_DFL);
        signal(SIGINT, SIG_DFL);
        execv(argv[2], &argv[2]);
        perror("execv");
        _exit(127);
    }
    fprintf(stderr, "{\"supervisorPid\":%d,\"ownerPid\":%d,\"childPid\":%d}\n", getpid(), owner, child);
    int status = 0;
    int stopping = 0;
    int escalated = 0;
    const char *reason = "child_exit";
    if (watch(queue, (uintptr_t)child, EVFILT_PROC, NOTE_EXIT) < 0) {
        // A child may complete between fork and event registration.
        if (waitpid(child, &status, WNOHANG) != child) {
            stopping = 1;
            reason = "child_watch_failed";
            kill(child, SIGTERM);
        } else {
            close(queue);
            unlink(argv[1]);
            return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
        }
    }
    for (;;) {
        if (waitpid(child, &status, WNOHANG) == child) break;
        struct kevent event;
        // Infrastructure cleanup grace, not a model request/Run deadline.
        // Normal measured exits took <100ms; terminate a child ignoring SIGTERM.
        const struct timespec grace = {.tv_sec = 5, .tv_nsec = 0};
        const int count = kevent(queue, NULL, 0, &event, 1, stopping ? &grace : NULL);
        if (count < 0 && errno == EINTR) continue;
        if (count < 0 || (count == 0 && stopping)) {
            escalated = 1;
            kill(child, SIGKILL);
            while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
            break;
        }
        if (count == 0) continue;
        if (event.filter == EVFILT_PROC && event.ident == (uintptr_t)child) {
            while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
            break;
        }
        if (!stopping) {
            stopping = 1;
            reason = event.filter == EVFILT_SIGNAL ? "owner_shutdown_signal" : "owner_exit";
            kill(child, SIGTERM);
        }
    }
    close(queue);
    const int removed = unlink(argv[1]) == 0 || errno == ENOENT;
    fprintf(stderr, "{\"reason\":\"%s\",\"escalated\":%s,\"socketRemoved\":%s,\"childExit\":%d}\n", reason, escalated ? "true" : "false", removed ? "true" : "false", WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status));
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
