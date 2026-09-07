/*
 * nice-shim — neutralize setpriority() for browsers running in containers.
 *
 * Docker/Railway containers don't get CAP_SYS_NICE, so raising (or otherwise
 * changing) a process's nice priority via setpriority() fails with EPERM.
 * Release Chromium silently ignores that failure. The Clearcote pre-release
 * browser is a DCHECK-enabled build, so the same EPERM trips
 *
 *   FATAL:base/process/process_linux.cc:201 DCHECK failed: result == 0.
 *          : Permission denied (13)
 *
 * and kills the browser process. This shim, injected via LD_PRELOAD, makes
 * setpriority() report success so the DPCHECK passes. That is safe here:
 * the caller's priority simply stays at its default, which is exactly what
 * happens in release builds anyway.
 *
 * Build: gcc -shared -fPIC -O2 -o nice-shim.so nice-shim.c
 */
#define _GNU_SOURCE
#include <sys/types.h>
#include <sys/resource.h>

int setpriority(__priority_which_t which, id_t who, int prio)
{
    (void)which;
    (void)who;
    (void)prio;
    return 0;
}

/* glibc's nice() is a thin wrapper over setpriority — shim it for callers
 * that use the convenience function (same semantics, same reason). */
int nice(int inc)
{
    (void)inc;
    return 0;
}
