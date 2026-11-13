/* Stable Node-API entry ABI; no Node/V8 headers or package dependencies.
 * Loaded in the credential-bearing proxy AFTER exec (exec resets dumpability).
 */
#include <sys/prctl.h>
typedef void *napi_env;
typedef void *napi_value;
extern int napi_throw_error(napi_env, const char *, const char *);

__attribute__((visibility("default")))
napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    if (prctl(PR_SET_DUMPABLE, 0L, 0L, 0L, 0L) != 0 ||
        prctl(PR_GET_DUMPABLE, 0L, 0L, 0L, 0L) != 0) {
        napi_throw_error(env, "process_isolation_failed", "Cannot disable proxy process dumpability");
        return (napi_value)0;
    }
    return exports;
}
