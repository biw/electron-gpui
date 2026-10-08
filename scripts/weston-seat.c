/* Headless Weston 13 omits wl_seat, which Electron 30 needs during startup.
 * Supply keyboard and pointer capabilities without using physical devices. */
#include <libweston/libweston.h>
#include <stdlib.h>

/* These exported backend interfaces are declared in Weston's private header,
 * which Ubuntu's libweston-13-dev does not install. */
void weston_seat_init(struct weston_seat *, struct weston_compositor *, const char *);
void weston_seat_release(struct weston_seat *);
int weston_seat_init_keyboard(struct weston_seat *, struct xkb_keymap *);
int weston_seat_init_pointer(struct weston_seat *);

struct virtual_seat {
    struct weston_seat seat;
    struct wl_listener destroy;
};

static void destroy_seat(struct wl_listener *listener, void *data)
{
    struct virtual_seat *seat = wl_container_of(listener, seat, destroy);
    (void)data;
    wl_list_remove(&seat->destroy.link);
    weston_seat_release(&seat->seat);
    free(seat);
}

WL_EXPORT int wet_module_init(struct weston_compositor *compositor, int *argc, char *argv[])
{
    struct virtual_seat *seat = calloc(1, sizeof(*seat));
    (void)argc;
    (void)argv;
    if (!seat)
        return -1;
    weston_seat_init(&seat->seat, compositor, "electron-gpui-test");
    if (weston_seat_init_keyboard(&seat->seat, NULL) < 0 ||
        weston_seat_init_pointer(&seat->seat) < 0) {
        weston_seat_release(&seat->seat);
        free(seat);
        return -1;
    }
    seat->destroy.notify = destroy_seat;
    wl_signal_add(&compositor->destroy_signal, &seat->destroy);
    return 0;
}
