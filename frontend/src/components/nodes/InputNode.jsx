import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Handle } from '@xyflow/react';
import { useDispatch, useSelector } from 'react-redux';
import BaseNode from './BaseNode';
import { setWorkflowInputVariable, deleteWorkflowInputVariable, updateWorkflowInputVariableKey, updateNodeData } from '../../store/flowSlice';
import { Input, Button } from "@nextui-org/react";
import { Icon } from '@iconify/react';
import styles from './DynamicNode.module.css';
import { useSaveWorkflow } from '../../hooks/useSaveWorkflow';

const InputNode = ({ id, data, ...props }) => {
  const dispatch = useDispatch();
  const workflowInputVariables = useSelector(state => state.flow.workflowInputVariables);
  const nodeRef = useRef(null);
  const [nodeWidth, setNodeWidth] = useState('auto');
  const [editingField, setEditingField] = useState(null);
  const [newFieldValue, setNewFieldValue] = useState('');
  const [handlePosition, setHandlePosition] = useState('-12px');

  // Get the fields from workflowInputVariables instead of schema
  const workflowInputKeys = Object.keys(workflowInputVariables);
  const hasWorkflowInputs = workflowInputKeys.length > 0;

  // Calculate node width based on content
  useEffect(() => {
    if (nodeRef.current) {
      const maxLabelLength = Math.max(
        ...workflowInputKeys.map(label => label.length),
        (data?.title || '').length / 1.5
      );

      const calculatedWidth = Math.max(300, maxLabelLength * 15);
      const finalWidth = Math.min(calculatedWidth, 600);

      const nodePadding = 26;
      const borderWidth = 2;
      setHandlePosition(`-${nodePadding + borderWidth}px`);

      setNodeWidth(`${finalWidth}px`);
    }
  }, [data, workflowInputKeys]);

  const saveWorkflow = useSaveWorkflow();
  const nodes = useSelector(state => state.flow.nodes);

  const syncAndSave = useCallback(() => {
    // Find this input node
    const inputNode = nodes.find(node => node.id === id);
    if (!inputNode) return;
    // Now save the workflow
    saveWorkflow();
  }, [id, nodes, workflowInputVariables, saveWorkflow]);


  // Sync and save whenever workflowInputVariables changes
  useEffect(() => {
    syncAndSave();
  }, [workflowInputVariables]);

  const handleAddField = useCallback(() => {
    if (!newFieldValue.trim()) return;
    const newKey = newFieldValue.trim();

    dispatch(setWorkflowInputVariable({
      key: newKey,
      value: ''
    }));
    setNewFieldValue('');
    // No need to call syncAndSave here, it will be triggered by the useEffect
  }, [dispatch, newFieldValue]);

  const handleDeleteField = useCallback((keyToDelete) => {
    dispatch(deleteWorkflowInputVariable({ key: keyToDelete }));
    // No need to call syncAndSave here, it will be triggered by the useEffect
  }, [dispatch]);

  const handleLabelEdit = useCallback((oldKey, newKey) => {
    if (oldKey === newKey || !newKey.trim()) {
      setEditingField(null);
      return;
    }

    dispatch(updateWorkflowInputVariableKey({ oldKey, newKey }));
    setEditingField(null);
    // No need to call syncAndSave here, it will be triggered by the useEffect
  }, [dispatch]);

  const renderWorkflowInputs = () => {
    return workflowInputKeys.map((key, index) => (
      <div key={key} className="relative w-full px-4 py-2">
        <div className="flex items-center gap-2">
          {editingField === key ? (
            <Input
              autoFocus
              defaultValue={key}
              size="sm"
              variant="faded"
              radius="lg"
              onBlur={(e) => handleLabelEdit(key, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleLabelEdit(key, e.target.value);
                } else if (e.key === 'Escape') {
                  setEditingField(null);
                }
              }}
              classNames={{
                input: "bg-default-100",
                inputWrapper: "shadow-none",
              }}
            />
          ) : (
            <div className="flex flex-col w-full gap-1">
              <div className="flex items-center justify-between">
                <span
                  className="text-sm font-medium text-default-600 cursor-pointer hover:text-primary"
                  onClick={() => setEditingField(key)}
                >
                  {key}
                </span>
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  color="danger"
                  onClick={() => handleDeleteField(key)}
                >
                  <Icon icon="solar:trash-bin-minimalistic-linear" width={16} />
                </Button>
              </div>
            </div>
          )}
        </div>
        <div className={styles.outputHandleWrapper} style={{ right: handlePosition }}>
          <Handle
            type="source"
            position="right"
            id={key}
            className={`${styles.handle} ${styles.handleRight}`}
            isConnectable={true}
          />
        </div>
      </div>
    ));
  };

  const renderAddField = () => (
    <div className="flex items-center gap-2 px-4 py-2">
      <Input
        placeholder="Enter new field name"
        value={newFieldValue}
        onChange={(e) => setNewFieldValue(e.target.value)}
        size="sm"
        variant="faded"
        radius="lg"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            handleAddField();
          }
        }}
        classNames={{
          input: "bg-default-100",
          inputWrapper: "shadow-none",
        }}
        endContent={
          <Button
            isIconOnly
            size="sm"
            variant="light"
            onClick={handleAddField}
            className="text-default-400 hover:text-default-500"
          >
            <Icon icon="solar:add-circle-bold" width={16} className="text-default-500" />
          </Button>
        }
      />
    </div>
  );

  return (
    <div style={{ position: 'relative' }}>
      <BaseNode
        id={id}
        type="input"
        isInputNode={true}
        data={{
          ...data,
          acronym: 'IN',
          color: '#2196F3',
        }}
        style={{ width: nodeWidth }}
        {...props}
      >
        <div className={styles.nodeWrapper} ref={nodeRef}>
          {renderWorkflowInputs()}
          {renderAddField()}
        </div>
      </BaseNode>
    </div>
  );
};

export default InputNode;
