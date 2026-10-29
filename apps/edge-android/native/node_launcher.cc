// Node's own main(), linked against nodejs-mobile's libnode.so. Built as an executable named
// libnode_launcher.so so Android installs it in the app's native library folder, the one place an
// app may run programs from. The app's foreground service starts it like `node entry.mjs`.
#include "node.h"

int main(int argc, char* argv[]) { return node::Start(argc, argv); }
