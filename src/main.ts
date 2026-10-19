if(process.argv.includes('--cleanup-monitor')) {
 const {cleanupMonitor}=await import('./cleanup');
 await cleanupMonitor();
} else {
 const {serveProvider}=await import('@archon/provider-contract/plugin');
 const {descriptor,Provider}=await import('./provider');
 await serveProvider({descriptor,create:()=>new Provider()});
}

export {};
