import { ExecutionDebugger, type DebuggerProps } from "./visualizer/ExecutionDebugger";
import { TraceDetailView } from "./trace/TraceDetailView";

export function VisualizerView({ configReady = false, ...props }: DebuggerProps & { configReady?: boolean }) {
  if (props.initialMode === "trace") {
    const source = props.initialChain === "l1" || props.initialChain === "l2" ? props.initialChain : "auto";
    return <TraceDetailView hash={props.initialDebugHash || ""} source={source} ready={configReady} onBack={props.onBack} />;
  }
  return <ExecutionDebugger {...props} />;
}
